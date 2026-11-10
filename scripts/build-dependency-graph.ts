/**
 * Builds the "Repository dependencies" page.
 *
 * The VersaTiles repositories depend on each other in half a dozen different
 * ways — npm packages, Rust crates, Docker base images, release assets pulled
 * by install scripts, reusable CI workflows — and each of those is declared in
 * a different file format. This script reads all of them from GitHub and turns
 * them into one diagram, so the shape of the project can be seen rather than
 * reconstructed.
 *
 * Nothing it writes is committed. Every CI run generates the page, its data and
 * the status snapshot afresh and deploys them, and a local build has a page to
 * show only after this script has run.
 *
 *   npm run sync:deps              # generate the page, its data and the status snapshot
 *   npm run sync:deps -- --cache   # also reuse releases and registry answers from the last 24 hours
 *   npm run sync:deps -- --drift   # report outdated versions instead (not committed)
 *   npm run sync:deps -- --drift --outdated   # … leaving out packages that are current
 *
 * A GitHub token is read from GITHUB_TOKEN, GH_TOKEN or `gh auth token`.
 *
 * Every run keeps the files it reads in STORE, under their git hashes, and
 * reads only what changed since. A run that completes removes what it did not
 * use. CI keeps the folder between runs, and deleting it costs one slower run.
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadConfig, validateConfig, CONFIG_PATH } from './dependency-graph/config';
import { GitHub, mapLimit, type Checkout, type RepoInfo } from './dependency-graph/github';
import { buildNameMaps, classify, collectEdges, type RepoFile } from './dependency-graph/collect';
import {
	collectBundles,
	collectDeployments,
	collectDrift,
	collectPins,
	renderDrift,
	type DriftResult,
} from './dependency-graph/drift';
import { Progress } from './dependency-graph/progress';
import { renderJson, renderPage } from './dependency-graph/render';
import { sortEdges, type Graph, type RepoNode } from './dependency-graph/model';
import { collectRepoStatus } from './dependency-graph/repo-status';
import { buildStatusSnapshot, renderStatusJson } from './dependency-graph/status';

const ROOT = resolve(__dirname, '..');
const TARGET_PAGE = 'index.md';
const TARGET_DATA = 'public/dependency-graph.json';
const TARGET_STATUS = 'public/status.json';
const STORE = '.cache/github';

/** Repositories the configuration says nothing about still have to go somewhere. */
const FALLBACK_TAG = {
	id: 'uncategorised',
	title: 'Not yet categorised',
	summary: 'Added to the organisation since this page was last curated.',
};

interface Options {
	cache: boolean;
	drift: boolean;
	outdated: boolean;
}

const FLAGS = ['--cache', '--drift', '--outdated'];

function parseArgs(argv: string[]): Options {
	const unknown = argv.filter((arg) => !FLAGS.includes(arg));
	if (unknown.length > 0) throw new Error(`unknown option(s): ${unknown.join(', ')}`);
	const options = {
		cache: argv.includes('--cache'),
		drift: argv.includes('--drift'),
		outdated: argv.includes('--outdated'),
	};
	if (options.outdated && !options.drift) throw new Error('--outdated only applies to --drift');
	return options;
}

/** Reads every file of a repository that could declare a dependency. */
async function readRepo(
	github: GitHub,
	org: string,
	repo: RepoInfo,
	commit: string | null,
	progress: Progress,
): Promise<{ checkout: Checkout; files: RepoFile[] }> {
	const checkout = await github.checkout(org, repo, commit);
	const wanted = checkout.entries
		.map((entry) => ({ path: entry.path, role: classify(entry.path) }))
		.filter((entry): entry is { path: string; role: NonNullable<typeof entry.role> } =>
			Boolean(entry.role),
		);

	progress.add('files', wanted.length);
	const files = await mapLimit(wanted, ({ path, role }) =>
		progress.track('files', async () => {
			const text = await github.readFile(org, checkout, path);
			return text === null ? null : { repo: repo.name, path, role, text };
		}),
	);
	return { checkout, files: files.filter((file): file is RepoFile => file !== null) };
}

/**
 * Without the head commits every read names the branch instead, as before:
 * slower, and open to a push during the run, but still correct.
 */
async function findHeads(github: GitHub, org: string): Promise<Map<string, string>> {
	try {
		return await github.heads(org);
	} catch (error) {
		console.warn(
			`[dependency-graph] could not find the head commits, so reading branches instead: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return new Map();
	}
}

async function main(): Promise<void> {
	const { cache, drift, outdated } = parseArgs(process.argv.slice(2));
	const config = loadConfig(ROOT);
	const github = new GitHub({ cache, store: resolve(ROOT, STORE) });

	const allRepos = await github.listRepos(config.org);
	const problems = validateConfig(config, new Set(allRepos.map((repo) => repo.name)));
	if (problems.length > 0) {
		throw new Error(`${problems.length} configuration problem(s):\n  ${problems.join('\n  ')}`);
	}

	// Decide what the graph covers before spending any requests on it.
	const skipped: { name: string; reason: string }[] = [];
	const repos = allRepos.filter((repo) => {
		if (config.exclude.includes(repo.name)) {
			skipped.push({ name: repo.name, reason: 'excluded in the configuration' });
			return false;
		}
		if (repo.archived && !config.includeArchived) {
			skipped.push({ name: repo.name, reason: 'archived' });
			return false;
		}
		if (repo.fork && !config.includeForks) {
			skipped.push({ name: repo.name, reason: 'a fork of an upstream project' });
			return false;
		}
		return true;
	});

	console.log(`[dependency-graph] reading ${repos.length} repositories of ${config.org} …`);
	const heads = await findHeads(github, config.org);
	const scan = new Progress('scanning');
	scan.add('repositories', repos.length);
	const scanned = await mapLimit(repos, (repo) =>
		scan.track('repositories', () =>
			readRepo(github, config.org, repo, heads.get(repo.name) ?? null, scan),
		),
	);
	scan.finish();
	const files = scanned.flatMap((result) => result.files);
	const checkouts = new Map(scanned.map(({ checkout }) => [checkout.repo, checkout]));
	console.log(
		`[dependency-graph] scanned ${files.length} files in ${github.requestCount} requests` +
			` (${github.storedCount} more from ${STORE})`,
	);

	const { maps, warnings: mapWarnings } = buildNameMaps(files);

	const collectVersions = async (): Promise<DriftResult> => {
		if (cache) {
			console.warn(
				'[dependency-graph] --cache: manifests, lockfiles and registry answers may come from\n' +
					'                  different runs, so versions can disagree with each other.',
			);
		}
		const lookup = new Progress('checking versions');
		const source = {
			// The same commit as the scan, so that manifests and lockfiles agree.
			readFile: (repo: string, path: string) =>
				github.readFile(config.org, checkouts.get(repo)!, path),
			getRegistryJson: (url: string) => github.getRegistryJson(url),
			latestRelease: async (repo: string) => {
				const release = await github.latestRelease(config.org, repo);
				return release
					? { version: release.tag, date: release.date || null, source: 'release' as const }
					: null;
			},
		};
		const tracked = <T, R>(items: readonly T[], worker: (item: T) => Promise<R>) => {
			lookup.add('lookups', items.length);
			return mapLimit(items, (item) => lookup.track('lookups', () => worker(item)));
		};
		const result = await collectDrift(files, maps, source, tracked);
		result.deployments = await collectDeployments(config.deployments, source, tracked);
		result.pins = [
			...(await collectPins(config.pins, config.pinnedImages, source, tracked)),
			...(await collectBundles(
				config.bundles,
				{
					latestRelease: source.latestRelease,
					releaseNotes: (repo) => github.latestRelease(config.org, repo),
				},
				tracked,
			)),
		];
		lookup.finish();
		return result;
	};

	// A repository nobody has placed yet goes last.
	const rank = (repo: string): number => {
		const index = config.updateOrder.indexOf(config.repositories[repo]?.[0] ?? '');
		return index === -1 ? config.updateOrder.length : index;
	};

	/** Run only once everything was read, or the next run fetches what was skipped. */
	const prune = (): void => {
		const removed = github.pruneStore();
		if (removed > 0) {
			console.log(`[dependency-graph] removed ${removed} files no longer needed from ${STORE}`);
		}
	};

	if (drift) {
		console.log(
			'\n' +
				renderDrift(await collectVersions(), {
					color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
					now: new Date(),
					onlyOutdated: outdated,
					rank,
				}),
		);
		prune();
		return;
	}
	const names = new Set(repos.map((repo) => repo.name));
	const { edges, warnings, ignoreHits } = collectEdges(files, config, maps, names, mapWarnings);

	config.ignore.forEach((rule, index) => {
		if (!ignoreHits.has(index)) {
			warnings.push(`ignore rule ${rule.from} → ${rule.to} matched nothing and can be removed`);
		}
	});

	const uncategorised = repos
		.filter((repo) => !config.repositories[repo.name])
		.map((repo) => repo.name);
	if (uncategorised.length > 0) {
		warnings.push(
			`not listed under "repositories:" in ${CONFIG_PATH}: ${uncategorised.sort().join(', ')}`,
		);
	}

	const nodes: RepoNode[] = repos.map((repo) => ({
		name: repo.name,
		tags: config.repositories[repo.name] ?? [FALLBACK_TAG.id],
		description: repo.description,
		language: repo.language,
		fork: repo.fork,
		archived: repo.archived,
	}));

	// Only tags that something actually carries are worth a filter or a heading.
	const inUse = new Set(nodes.flatMap((node) => node.tags));
	const graph: Graph = {
		org: config.org,
		tags: [
			...config.tags.filter((tag) => inUse.has(tag.id)),
			...(uncategorised.length > 0 ? [FALLBACK_TAG] : []),
		],
		repos: nodes,
		edges: sortEdges(edges),
	};

	const page = renderPage({
		graph,
		branches: new Map(repos.map((repo) => [repo.name, repo.defaultBranch])),
		skipped,
	});

	for (const warning of warnings) console.warn(`[dependency-graph] ${warning}`);

	writeFileSync(resolve(ROOT, TARGET_PAGE), page);
	writeFileSync(resolve(ROOT, TARGET_DATA), renderJson(graph));
	console.log(
		`[dependency-graph] ${graph.repos.length} repositories, ${graph.edges.length} dependencies`,
	);

	const collectRepos = () =>
		collectRepoStatus(
			(query, variables) => github.graphql(query, variables),
			config.org,
			new Set(repos.map((repo) => repo.name)),
		);
	const snapshot = await buildStatusSnapshot(collectVersions, collectRepos, {
		org: config.org,
		now: new Date(),
		rank,
	});
	if (snapshot.repos.status === 'failed') {
		console.warn(`[dependency-graph] status: repositories not checked: ${snapshot.repos.error}`);
	}
	writeFileSync(resolve(ROOT, TARGET_STATUS), renderStatusJson(snapshot));
	if (snapshot.drift.status === 'failed') {
		// Lockfiles it never got to would be pruned, only to be fetched again next time.
		console.warn(`[dependency-graph] status: versions not checked: ${snapshot.drift.error}`);
	} else {
		console.log(`[dependency-graph] status snapshot written to ${TARGET_STATUS}`);
		prune();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
