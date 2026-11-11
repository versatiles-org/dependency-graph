import { describe, expect, it } from 'vitest';
import {
	assess,
	buildDriftReport,
	type DeploymentFinding,
	type DeploymentReport,
	type PinFinding,
	type DriftReport,
	type Release,
	type Usage,
} from './drift';
import type { RepoStatus } from './repo-status';
import {
	countOpen,
	daysAgo,
	filterDeployments,
	filterDrift,
	filterPins,
	formatUtc,
	hoursAgo,
	isStale,
	listRepos,
	pinLocation,
	waitingOn,
} from './status-view';

const now = new Date('2026-11-01T12:00:00Z');

describe('times', () => {
	it('says how many days ago something was', () => {
		expect(daysAgo('2026-11-01T01:00:00Z', now)).toBe('today');
		expect(daysAgo('2026-10-31T12:00:00Z', now)).toBe('1 day ago');
		expect(daysAgo('2026-10-20T12:00:00Z', now)).toBe('12 days ago');
	});

	it('counts in hours for two days, and in days after that', () => {
		expect(hoursAgo('2026-11-01T11:30:00Z', now)).toBe('less than an hour ago');
		expect(hoursAgo('2026-11-01T11:00:00Z', now)).toBe('1 hour ago');
		expect(hoursAgo('2026-10-31T12:00:00Z', now)).toBe('24 hours ago');
		expect(hoursAgo('2026-10-29T12:00:00Z', now)).toBe('3 days ago');
	});

	it('calls a snapshot stale once scheduled runs should have replaced it', () => {
		expect(isStale('2026-11-01T00:00:00Z', now)).toBe(false);
		expect(isStale('2026-10-31T23:59:00Z', now)).toBe(true);
	});

	it('formats a date without depending on the time zone', () => {
		expect(formatUtc('2026-11-01T10:43:03.727Z')).toBe('2026-11-01 10:43 UTC');
	});
});

describe('pinLocation', () => {
	const none = { path: null, image: null, tag: null, component: null };

	it('names the file, the image or the release that holds the version', () => {
		expect(pinLocation({ ...none, path: 'Formula/x.rb' })).toBe('Formula/x.rb');
		expect(pinLocation({ ...none, image: 'org/image' })).toBe('org/image');
		expect(pinLocation({ ...none, tag: 'v3.16.1', component: 'Style' })).toBe('v3.16.1: Style');
	});

	it('still names the component when the release could not be read', () => {
		expect(pinLocation({ ...none, component: 'Style' })).toBe('latest release: Style');
	});
});

describe('countOpen', () => {
	it('counts only what is left to do', () => {
		expect(
			countOpen({
				queue: [{}, {}],
				packages: [
					{ usages: [{ status: 'current' }, { status: 'range' }] },
					{ usages: [{ status: 'stale-lock' }] },
					{ usages: [{ status: 'ahead' }, { status: 'unknown' }, { status: 'current' }] },
				],
				pins: [{ status: 'behind' }, { status: 'current' }, { status: 'unknown' }],
				deployments: [
					{ findings: [{ status: 'behind' }, { status: 'behind' }] },
					{ findings: [{ status: 'ahead' }] },
				],
				repos: [{ ci: 'failing' }, { ci: 'passing' }, { ci: 'none' }],
			}),
		).toEqual({ queue: 2, packages: 2, pins: 1, deployments: 2, repos: 1 });
	});
});

describe('listRepos', () => {
	const repo = (name: string, ci: RepoStatus['ci']): RepoStatus => ({
		name,
		branch: 'main',
		issues: 0,
		pulls: 0,
		botPulls: 0,
		ci,
		lastCommit: null,
		release: null,
		unreleased: null,
	});
	const repos = [
		repo('c', 'passing'),
		repo('b', 'failing'),
		repo('a', 'none'),
		repo('ab', 'running'),
	];

	it('puts what is failing first, and the rest by name', () => {
		expect(listRepos(repos, '').map((entry) => entry.name)).toEqual(['b', 'a', 'ab', 'c']);
	});

	it('finds a repository by part of its name, whatever its case', () => {
		expect(listRepos(repos, ' A ').map((entry) => entry.name)).toEqual(['a', 'ab']);
	});

	it('leaves the list it was given in its order', () => {
		listRepos(repos, '');
		expect(repos[0].name).toBe('c');
	});
});

describe('filterPins', () => {
	const pin = (overrides: Partial<PinFinding>): PinFinding => ({
		repo: 'homebrew-versatiles',
		path: null,
		image: null,
		tag: null,
		component: null,
		provider: 'versatiles-rs',
		pinned: '1.0.0',
		latest: null,
		status: 'current',
		behind: null,
		note: '',
		...overrides,
	});
	const pins = [
		pin({ path: 'Formula/versatiles.rb' }),
		pin({ repo: 'versatiles-docker', image: 'versatiles/versatiles-nginx' }),
		pin({
			repo: 'versatiles-frontend',
			provider: 'versatiles-style',
			tag: 'v1.0.0',
			component: 'VersaTiles Style',
		}),
		pin({ repo: 'versatiles-frontend', provider: null, component: 'Brand New Thing' }),
	];
	const found = (query: string) => filterPins(pins, query).map((entry) => pinLocation(entry));

	it('keeps everything without a query', () => {
		expect(filterPins(pins, ' ')).toHaveLength(4);
	});

	it('finds a pin by its repository, what it names, or where it is', () => {
		expect(found('HOMEBREW')).toEqual(['Formula/versatiles.rb']);
		expect(found('versatiles-style')).toEqual(['v1.0.0: VersaTiles Style']);
		expect(found('nginx')).toEqual(['versatiles/versatiles-nginx']);
		expect(found('brand new')).toEqual(['latest release: Brand New Thing']);
		expect(found('nothing like it')).toEqual([]);
	});
});

describe('filterDeployments', () => {
	const finding = (component: string, provider: string | null): DeploymentFinding => ({
		component,
		provider,
		deployed: '1.0.0',
		latest: null,
		status: 'current',
		behind: null,
		note: '',
	});
	const deployments: DeploymentReport[] = [
		{
			repo: 'tiles.versatiles.org',
			url: 'https://example.org',
			components: {},
			updated: null,
			reachable: true,
			findings: [finding('frontend', 'versatiles-frontend'), finding('other', null)],
		},
	];

	it('keeps a whole deployment when its repository matches', () => {
		expect(filterDeployments(deployments, 'tiles')[0].findings).toHaveLength(2);
		expect(filterDeployments(deployments, '')).toEqual(deployments);
	});

	it('narrows a deployment down to the components that match', () => {
		expect(filterDeployments(deployments, 'versatiles-frontend')[0].findings).toHaveLength(1);
		expect(filterDeployments(deployments, 'OTHER')[0].findings[0].component).toBe('other');
	});

	it('leaves out a deployment with nothing that matches', () => {
		expect(filterDeployments(deployments, 'nothing like it')).toEqual([]);
	});
});

describe('waitingOn', () => {
	// Only who uses whom matters here.
	const report = (
		uses: [string, string, boolean?][],
		queue: [string, string[]][],
	): Pick<DriftReport, 'packages' | 'dependents'> =>
		({
			packages: [
				{
					usages: uses.map(([consumer, provider, tooling = false]) => ({
						consumer,
						provider,
						tooling,
					})),
				},
			],
			dependents: queue.map(([consumer, behind]) => ({
				consumer,
				outdated: behind.map((provider) => ({ consumer, provider })),
			})),
		}) as unknown as Pick<DriftReport, 'packages' | 'dependents'>;

	const queue: [string, string[]][] = [
		['container', ['x']],
		['svelte', ['style']],
		['server', ['style']],
		['frontend', ['style']],
		['tools', ['container']],
	];
	const uses: [string, string][] = [
		['container', 'x'],
		['svelte', 'style'],
		['server', 'style'],
		['server', 'container'],
		['frontend', 'style'],
		['frontend', 'server'],
		['tools', 'container'],
		['tools', 'svelte'],
		['tools', 'helper'],
		['helper', 'server'],
	];

	/** Waits that ship. */
	const waits = (...providers: string[]) =>
		providers.map((provider) => ({ provider, tooling: false }));

	it('finds the repositories in the queue a repository uses without being behind on them', () => {
		expect(waitingOn(report(uses, queue))).toEqual({
			server: waits('container'),
			// One reached through a repository outside the queue counts as well.
			tools: waits('server', 'svelte'),
			// What server waits for is for server to show.
			frontend: waits('server'),
		});
	});

	it('says which waits only development tooling leads to', () => {
		const tooling = (consumer: string, provider: string): [string, string, boolean] => [
			consumer,
			provider,
			true,
		];
		const result = waitingOn(
			report(
				[
					...uses.filter(([consumer]) => consumer !== 'tools'),
					tooling('tools', 'svelte'),
					// The direct way to server is tooling, but the one through helper ships.
					tooling('tools', 'server'),
					['tools', 'helper'],
					['helper', 'server'],
				],
				queue.filter(([consumer]) => consumer !== 'tools').concat([['tools', ['x']]]),
			),
		);
		expect(result.tools).toEqual([
			{ provider: 'server', tooling: false },
			{ provider: 'svelte', tooling: true },
		]);
		// Usages that ship lead from frontend to server.
		expect(result.frontend).toEqual(waits('server'));
	});

	it('leaves out anything outside the queue', () => {
		expect(waitingOn(report(uses, [['tools', ['container']]]))).toEqual({});
	});

	it('copes with a cycle', () => {
		const cycle = report(
			[
				['a', 'b'],
				['b', 'a'],
			],
			[
				['a', ['x']],
				['b', ['x']],
			],
		);
		expect(waitingOn(cycle)).toEqual({ a: waits('b'), b: waits('a') });
	});
});

describe('filterDrift', () => {
	const release = (version: string): Release => ({ version, date: null, source: 'registry' });
	const style = release('6.0.3');
	const fonts = release('2.0.0');

	const usage = (overrides: Partial<Usage>): Usage => ({
		ecosystem: 'npm',
		name: '@versatiles/style',
		provider: 'versatiles-style',
		consumer: 'a',
		path: 'package.json',
		section: 'dependencies',
		tooling: false,
		requested: '^6.0.1',
		installed: '6.0.1',
		lockPath: 'package-lock.json',
		...overrides,
	});
	const fontUsage = (overrides: Partial<Usage>): Usage =>
		usage({ name: '@versatiles/fonts', provider: 'versatiles-fonts', ...overrides });

	const report = buildDriftReport({
		findings: [
			assess(usage({ consumer: 'first' }), style),
			assess(usage({ consumer: 'second', section: 'devDependencies', tooling: true }), style),
			assess(fontUsage({ consumer: 'second', requested: '^2.0.0', installed: '2.0.0' }), fonts),
		],
		releases: new Map([
			['npm:@versatiles/style', style],
			['npm:@versatiles/fonts', fonts],
		]),
	});
	const all = { query: '', hideTooling: false, onlyOutdated: false };

	it('keeps everything without a filter, numbered by place in the queue', () => {
		const { queue, packages } = filterDrift(report, all);
		expect(queue.map((entry) => [entry.position, entry.consumer])).toEqual([
			[1, 'first'],
			[2, 'second'],
		]);
		expect(packages).toHaveLength(2);
	});

	it('finds a repository in the queue, and keeps its number', () => {
		const { queue, packages } = filterDrift(report, { ...all, query: ' SECOND ' });
		expect(queue.map((entry) => [entry.position, entry.consumer])).toEqual([[2, 'second']]);
		// A repository is found as the user of a package, with only its own usages.
		expect(packages.flatMap((entry) => entry.usages.map((row) => row.consumer))).toEqual([
			'second',
			'second',
		]);
	});

	it('finds a package, by its name or by the repository publishing it', () => {
		for (const query of ['@versatiles/style', 'versatiles-style']) {
			const { packages } = filterDrift(report, { ...all, query });
			expect(packages.map((entry) => entry.name)).toEqual(['@versatiles/style']);
			expect(packages[0].usages).toHaveLength(2);
		}
		const { queue } = filterDrift(report, { ...all, query: '@versatiles/style' });
		expect(queue.map((entry) => entry.consumer)).toEqual(['first', 'second']);
	});

	it('drops a repository whose only outdated usages are development tooling', () => {
		const { queue, packages } = filterDrift(report, { ...all, hideTooling: true });
		expect(queue.map((entry) => entry.consumer)).toEqual(['first']);
		expect(packages.flatMap((entry) => entry.usages.map((row) => row.consumer))).toEqual([
			'second',
			'first',
		]);
	});

	it('can leave out packages that are fully current', () => {
		const { packages } = filterDrift(report, { ...all, onlyOutdated: true });
		expect(packages.map((entry) => entry.name)).toEqual(['@versatiles/style']);
	});

	it('leaves the report it was given untouched', () => {
		const before = JSON.stringify(report);
		filterDrift(report, { query: 'second', hideTooling: true, onlyOutdated: true });
		expect(JSON.stringify(report)).toBe(before);
	});
});
