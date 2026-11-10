/**
 * Minimal GitHub reader for scripts/build-dependency-graph.ts.
 *
 * The graph is built from the organisation's public repositories rather than
 * from local clones, so it describes what is actually published — not what
 * happens to be checked out on somebody's laptop.
 *
 * One GraphQL request finds the head commit of every repository, and every read
 * after that names the commit rather than the branch, so that a push during a
 * run cannot mix two states of one repository. One request per repository lists
 * its files (`/repos/…/git/trees`); the handful of files that can carry a
 * dependency are then read from raw.githubusercontent.com, which does not count
 * against the API rate limit.
 *
 * Listings and files are kept in an object store under their git hashes. A hash
 * names one content forever, so the store never goes stale, and a repository
 * that has not changed since the last run costs no request at all.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'fs';
import { dirname, resolve } from 'path';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/** Anything larger is data or a bundle, never a dependency manifest. */
const MAX_BLOB_BYTES = 512 * 1024;

/** Parallel requests: high enough to be quick, low enough to stay polite. */
const CONCURRENCY = 12;

/**
 * Caps requests in flight across the whole run. mapLimit is used at two levels
 * — repositories, and the files inside one — so without a shared gate the two
 * limits would multiply.
 */
class Gate {
	private active = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private readonly limit: number) {}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((go) => this.waiting.push(go));
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

export interface RepoInfo {
	name: string;
	description: string | null;
	language: string | null;
	archived: boolean;
	fork: boolean;
	defaultBranch: string;
}

export interface RepoEntry {
	path: string;
	size: number;
}

export interface TreeFile extends RepoEntry {
	/** Git's hash of the file's content. */
	sha: string;
}

/** A repository as of one commit, which every read from it names. */
export interface Checkout {
	repo: string;
	/** The head commit, or the branch when the commit could not be found out. */
	ref: string;
	/** Every file in that state, by path. */
	files: Map<string, TreeFile>;
	/** False when GitHub cut the listing short, so a file missing from it may exist. */
	complete: boolean;
	/** The files small enough to be a manifest. */
	entries: RepoEntry[];
}

const SHA = /^[0-9a-f]{40}$/;
/** What `ObjectStore.write` leaves behind when a run stops halfway. */
const LEFTOVER = /^[0-9a-f]{40}\.\d+\.tmp$/;
const KINDS = ['blobs', 'trees'] as const;
type Kind = (typeof KINDS)[number];

/** Git's name for a file's content, so that a stored copy can be checked against it. */
export function blobSha(text: string): string {
	const bytes = Buffer.from(text, 'utf8');
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Files by their blob hash and listings by their commit. Neither can change
 * under its name, so nothing here expires. A file is checked against its hash
 * when read back, so a damaged copy is fetched again rather than believed.
 *
 * What a run reads or writes is remembered, so that `prune` can drop the rest:
 * old lockfiles would otherwise pile up with every release.
 */
export class ObjectStore {
	private readonly used: Record<Kind, Set<string>> = { blobs: new Set(), trees: new Set() };

	constructor(private readonly dir: string) {}

	private path(kind: Kind, sha: string): string | null {
		return SHA.test(sha) ? resolve(this.dir, kind, sha) : null;
	}

	/** Written beside the target and renamed, so that an interrupted run leaves no half file. */
	private write(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, content);
		renameSync(temporary, path);
	}

	readBlob(sha: string): string | null {
		const path = this.path('blobs', sha);
		if (!path || !existsSync(path)) return null;
		const text = readFileSync(path, 'utf8');
		if (blobSha(text) !== sha) return null;
		this.used.blobs.add(sha);
		return text;
	}

	/**
	 * Keeps only what matches its hash. A file that is not UTF-8, or that starts
	 * with a byte order mark, is never stored, and is fetched again next time.
	 */
	writeBlob(sha: string, text: string): void {
		const path = this.path('blobs', sha);
		if (!path || blobSha(text) !== sha) return;
		this.write(path, text);
		this.used.blobs.add(sha);
	}

	readTree(commit: string): TreeFile[] | null {
		const path = this.path('trees', commit);
		if (!path || !existsSync(path)) return null;
		try {
			const files = JSON.parse(readFileSync(path, 'utf8')) as unknown;
			if (!Array.isArray(files)) return null;
			this.used.trees.add(commit);
			return files as TreeFile[];
		} catch {
			return null;
		}
	}

	writeTree(commit: string, files: TreeFile[]): void {
		const path = this.path('trees', commit);
		if (!path) return;
		this.write(path, JSON.stringify(files));
		this.used.trees.add(commit);
	}

	/**
	 * Removes every object this run did not use, and what interrupted runs left
	 * half written, so that the store holds one run's worth and no more. Only
	 * names this store could have written are touched. Returns how many went.
	 */
	prune(): number {
		let removed = 0;
		for (const kind of KINDS) {
			const dir = resolve(this.dir, kind);
			if (!existsSync(dir)) continue;
			for (const name of readdirSync(dir)) {
				const unused = SHA.test(name) && !this.used[kind].has(name);
				if (!unused && !LEFTOVER.test(name)) continue;
				unlinkSync(resolve(dir, name));
				removed++;
			}
		}
		return removed;
	}
}

const HEADS_QUERY = `query ($org: String!, $after: String) {
  organization(login: $org) {
    repositories(first: 100, after: $after, privacy: PUBLIC) {
      pageInfo { hasNextPage endCursor }
      nodes { name defaultBranchRef { target { oid } } }
    }
  }
}`;

interface HeadsAnswer {
	organization: {
		repositories: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: ({
				name: string;
				defaultBranchRef: { target: { oid: string } | null } | null;
			} | null)[];
		};
	} | null;
}

/** Runs `worker` over `items`, at most CONCURRENCY at a time, preserving order. */
export async function mapLimit<T, R>(
	items: readonly T[],
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * A token is not strictly required, but 60 unauthenticated requests per hour
 * are not enough for an organisation this size. Falling back to `gh auth token`
 * keeps local runs working without anyone having to export anything.
 */
function resolveToken(): string | undefined {
	const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (fromEnv) return fromEnv;
	try {
		const token = execFileSync('gh', ['auth', 'token'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

/** Marker stored in the cache for a 404, so misses are not retried. */
const CACHED_404 = ' 404';

/** Long enough for a day of working on the scripts, short enough not to pass for current. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isCacheFresh(modifiedMs: number, nowMs: number): boolean {
	return nowMs - modifiedMs < CACHE_MAX_AGE_MS;
}

export class GitHub {
	private readonly headers: Record<string, string>;
	/** Set only with --cache: a developer convenience, never used by CI. */
	private readonly cacheDir: string | null;
	/** Safe for every run, CI included, because what it holds cannot go stale. */
	private readonly store: ObjectStore | null;
	private readonly gate = new Gate(CONCURRENCY);
	private requests = 0;
	private stored = 0;

	constructor(options: { cache: boolean; store?: string | null }) {
		const token = resolveToken();
		if (!token) {
			console.warn(
				'[dependency-graph] no GitHub token found — expect rate limiting.\n' +
					'                  Set GITHUB_TOKEN or run `gh auth login`.',
			);
		}
		this.headers = {
			accept: 'application/vnd.github+json',
			'user-agent': 'versatiles-org/dependency-graph',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		};
		this.cacheDir = options.cache
			? resolve(__dirname, '../../node_modules/.cache/dependency-graph')
			: null;
		this.store = options.store ? new ObjectStore(options.store) : null;
	}

	get requestCount(): number {
		return this.requests;
	}

	/** Listings and files taken from the object store instead of from GitHub. */
	get storedCount(): number {
		return this.stored;
	}

	/**
	 * Drops from the object store what this run did not use. Only call it after
	 * a run that read everything it needs: whatever it skipped is fetched again.
	 */
	pruneStore(): number {
		return this.store?.prune() ?? 0;
	}

	private cachePath(url: string): string | null {
		if (!this.cacheDir) return null;
		mkdirSync(this.cacheDir, { recursive: true });
		return resolve(this.cacheDir, createHash('sha256').update(url).digest('hex'));
	}

	/** Returns the response body, or null for 404. Retries transient failures. */
	private async get(
		url: string,
		headers = this.headers,
		postBody?: string,
	): Promise<string | null> {
		const cached = this.cachePath(url + (postBody ?? ''));
		if (cached && existsSync(cached) && isCacheFresh(statSync(cached).mtimeMs, Date.now())) {
			const body = readFileSync(cached, 'utf8');
			return body === CACHED_404 ? null : body;
		}

		let lastError = '';
		for (let attempt = 0; attempt < 4; attempt++) {
			if (attempt > 0) await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
			this.requests++;

			let response: Response;
			try {
				const init =
					postBody === undefined ? { headers } : { method: 'POST', headers, body: postBody };
				response = await this.gate.run(() => fetch(url, init));
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				continue;
			}

			if (response.status === 404) {
				if (cached) writeFileSync(cached, CACHED_404);
				return null;
			}
			if (response.ok) {
				const body = await response.text();
				if (cached) writeFileSync(cached, body);
				return body;
			}

			// 403 and 429 with an exhausted budget are rate limiting rather than a
			// permission problem, so they are worth another attempt after a pause.
			lastError = `${response.status} ${response.statusText}`;
			const retryable =
				response.status >= 500 || response.status === 403 || response.status === 429;
			if (!retryable) break;
		}
		throw new Error(`${lastError} for ${url}`);
	}

	/**
	 * Answers a GraphQL query. Partial answers count as failures: a field left out
	 * by an error would otherwise read as "nothing open" or "no checks".
	 */
	async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
		const body = await this.get(
			`${API}/graphql`,
			this.headers,
			JSON.stringify({ query, variables }),
		);
		const answer = JSON.parse(body ?? '{}') as { data?: T; errors?: { message?: string }[] };
		if (answer.errors?.length) {
			throw new Error(`GraphQL: ${answer.errors[0].message ?? 'unknown error'}`);
		}
		if (answer.data === undefined) throw new Error('GraphQL: no data in the answer');
		return answer.data;
	}

	private async getJson<T>(url: string): Promise<T | null> {
		const body = await this.get(url);
		return body === null ? null : (JSON.parse(body) as T);
	}

	/** Tag, date and notes of the latest release of a repository, or null if it has none. */
	async latestRelease(
		org: string,
		repo: string,
	): Promise<{ tag: string; date: string; notes: string } | null> {
		const release = await this.getJson<{
			tag_name?: string;
			published_at?: string;
			body?: string | null;
		}>(`${API}/repos/${org}/${repo}/releases/latest`);
		if (!release?.tag_name) return null;
		return {
			tag: release.tag_name,
			date: release.published_at ?? '',
			notes: release.body ?? '',
		};
	}

	/** Public repositories of `org`, sorted by name. */
	async listRepos(org: string): Promise<RepoInfo[]> {
		interface ApiRepo {
			name: string;
			description: string | null;
			language: string | null;
			archived: boolean;
			fork: boolean;
			default_branch: string;
		}

		const repos: RepoInfo[] = [];
		for (let page = 1; ; page++) {
			const url = `${API}/orgs/${org}/repos?type=public&per_page=100&page=${page}`;
			const batch = await this.getJson<ApiRepo[]>(url);
			if (!batch?.length) break;
			for (const repo of batch) {
				repos.push({
					name: repo.name,
					description: repo.description,
					language: repo.language,
					archived: repo.archived,
					fork: repo.fork,
					defaultBranch: repo.default_branch,
				});
			}
			if (batch.length < 100) break;
		}
		return repos.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * The head commit of the default branch of each public repository. A
	 * repository without commits has none, and is left out.
	 */
	async heads(org: string): Promise<Map<string, string>> {
		const heads = new Map<string, string>();
		let after: string | null = null;
		do {
			const answer: HeadsAnswer = await this.graphql<HeadsAnswer>(HEADS_QUERY, { org, after });
			const repositories = answer.organization?.repositories;
			if (!repositories) throw new Error(`GraphQL: no organisation ${org}`);
			for (const node of repositories.nodes) {
				const oid = node?.defaultBranchRef?.target?.oid;
				if (node && oid) heads.set(node.name, oid);
			}
			after = repositories.pageInfo.hasNextPage ? repositories.pageInfo.endCursor : null;
		} while (after);
		return heads;
	}

	/**
	 * Lists every file of a repository as of `commit`, or of its default branch
	 * when the commit is not known. Only a listing named by its commit is stored,
	 * and only a complete one.
	 */
	async checkout(org: string, repo: RepoInfo, commit: string | null): Promise<Checkout> {
		const ref = commit ?? repo.defaultBranch;
		const make = (files: TreeFile[], complete: boolean): Checkout => ({
			repo: repo.name,
			ref,
			files: new Map(files.map((file) => [file.path, file])),
			complete,
			entries: files
				.filter((file) => file.size <= MAX_BLOB_BYTES)
				.map(({ path, size }) => ({ path, size })),
		});

		const stored = commit ? this.store?.readTree(commit) : null;
		if (stored) {
			this.stored++;
			return make(stored, true);
		}

		const url = `${API}/repos/${org}/${repo.name}/git/trees/${ref}?recursive=1`;
		const tree = await this.getJson<{
			truncated?: boolean;
			tree?: { path: string; type: string; sha: string; size?: number }[];
		}>(url);
		if (!tree?.tree) return make([], true);
		if (tree.truncated) {
			console.warn(`[dependency-graph] ${repo.name}: file listing truncated by GitHub`);
		}
		const files = tree.tree
			.filter((entry) => entry.type === 'blob')
			.map((entry) => ({ path: entry.path, size: entry.size ?? 0, sha: entry.sha }));
		if (commit && !tree.truncated) this.store?.writeTree(commit, files);
		return make(files, !tree.truncated);
	}

	/**
	 * A file as of the checkout's commit, or null if it has no such file. A
	 * complete listing answers that without asking GitHub.
	 */
	async readFile(org: string, checkout: Checkout, path: string): Promise<string | null> {
		const file = checkout.files.get(path);
		if (!file && checkout.complete) return null;

		const stored = file ? this.store?.readBlob(file.sha) : null;
		if (stored != null) {
			this.stored++;
			return stored;
		}

		const text = await this.get(`${RAW}/${org}/${checkout.repo}/${checkout.ref}/${path}`);
		if (text !== null && file) this.store?.writeBlob(file.sha, text);
		return text;
	}

	/**
	 * A JSON document from a package registry, or null for 404. Goes through the
	 * same cache and retries, but never carries the GitHub token to a third party.
	 */
	async getRegistryJson<T>(url: string): Promise<T | null> {
		const body = await this.get(url, {
			accept: 'application/json',
			'user-agent': this.headers['user-agent'],
		});
		return body === null ? null : (JSON.parse(body) as T);
	}
}
