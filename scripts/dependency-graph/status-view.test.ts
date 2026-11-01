import { describe, expect, it } from 'vitest';
import { assess, buildDriftReport, type Release, type Usage } from './drift';
import {
	daysAgo,
	filterDrift,
	formatUtc,
	hoursAgo,
	isCommand,
	isDev,
	isStale,
	pinLocation,
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

describe('isDev', () => {
	it('recognises development sections of npm and Cargo', () => {
		expect(isDev({ section: 'devDependencies' })).toBe(true);
		expect(isDev({ section: 'dev-dependencies' })).toBe(true);
		expect(isDev({ section: 'workspace.dev-dependencies' })).toBe(true);
		expect(isDev({ section: "target.'cfg(unix)'.dev-dependencies" })).toBe(true);
		expect(isDev({ section: 'dependencies' })).toBe(false);
		expect(isDev({ section: 'workspace.dependencies' })).toBe(false);
		expect(isDev({ section: 'peerDependencies' })).toBe(false);
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

describe('isCommand', () => {
	it('tells commands from instructions', () => {
		expect(isCommand('npm update @versatiles/style')).toBe(true);
		expect(isCommand('cd web && npm update @versatiles/style')).toBe(true);
		expect(isCommand('cargo update -p versatiles_core')).toBe(true);
		expect(isCommand('widen the peer range to include 6.0.0')).toBe(false);
		expect(isCommand('set versatiles_core = "5.0.0" in Cargo.toml')).toBe(false);
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
			assess(usage({ consumer: 'second', section: 'devDependencies' }), style),
			assess(fontUsage({ consumer: 'second', requested: '^2.0.0', installed: '2.0.0' }), fonts),
		],
		releases: new Map([
			['npm:@versatiles/style', style],
			['npm:@versatiles/fonts', fonts],
		]),
	});
	const all = { query: '', hideDev: false, onlyOutdated: false };

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

	it('drops a repository whose only outdated usages are for development', () => {
		const { queue, packages } = filterDrift(report, { ...all, hideDev: true });
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
		filterDrift(report, { query: 'second', hideDev: true, onlyOutdated: true });
		expect(JSON.stringify(report)).toBe(before);
	});
});
