import { describe, expect, it } from 'vitest';
import { assess, type Usage } from './drift';
import type { RepoStatus } from './repo-status';
import { buildStatusSnapshot, readStatusSnapshot, renderStatusJson } from './status';

const options = { org: 'versatiles-org', now: new Date('2026-11-01T12:00:00Z') };

const usage = (consumer: string): Usage => ({
	ecosystem: 'npm',
	name: '@versatiles/style',
	provider: 'versatiles-style',
	consumer,
	path: 'package.json',
	section: 'dependencies',
	requested: '^6.0.1',
	installed: '6.0.1',
	lockPath: 'package-lock.json',
});

const latest = { version: '6.0.3', date: null, source: 'registry' as const };

const collected = () =>
	Promise.resolve({
		findings: [assess(usage('a'), latest), assess(usage('b'), latest)],
		releases: new Map([['npm:@versatiles/style', latest]]),
	});

const repo: RepoStatus = {
	name: 'a',
	branch: 'main',
	issues: 1,
	pulls: 0,
	botPulls: 0,
	ci: 'passing',
	lastCommit: null,
	release: null,
	unreleased: null,
};
const repos = () => Promise.resolve([repo]);
const down = () => Promise.reject(new Error('503'));

describe('buildStatusSnapshot', () => {
	it('records when the data was collected, the report and the repositories', async () => {
		const snapshot = await buildStatusSnapshot(collected, repos, options);
		expect(snapshot.generatedAt).toBe('2026-11-01T12:00:00.000Z');
		expect(snapshot.drift).toMatchObject({ status: 'ok', data: { totals: { usages: 2 } } });
		expect(snapshot.repos).toEqual({ status: 'ok', data: [repo] });
	});

	it('passes the rank on to the update order', async () => {
		const snapshot = await buildStatusSnapshot(collected, repos, {
			...options,
			rank: (name) => (name === 'b' ? 0 : 1),
		});
		if (snapshot.drift.status !== 'ok') throw new Error('expected a report');
		expect(snapshot.drift.data.dependents.map((entry) => entry.consumer)).toEqual(['b', 'a']);
	});

	it('records a failure of the report, and keeps the repositories', async () => {
		const snapshot = await buildStatusSnapshot(
			() => Promise.reject(new Error('503 for https://registry.npmjs.org/x')),
			repos,
			options,
		);
		expect(snapshot).toEqual({
			org: 'versatiles-org',
			generatedAt: '2026-11-01T12:00:00.000Z',
			drift: { status: 'failed', error: '503 for https://registry.npmjs.org/x' },
			repos: { status: 'ok', data: [repo] },
		});
	});

	it('records a failure of the repositories, and keeps the report', async () => {
		const snapshot = await buildStatusSnapshot(collected, down, options);
		expect(snapshot.repos).toEqual({ status: 'failed', error: '503' });
		expect(snapshot.drift.status).toBe('ok');
	});
});

describe('readStatusSnapshot', () => {
	it('reads back what was written, whether it succeeded or failed', async () => {
		const written = await buildStatusSnapshot(collected, repos, options);
		expect(readStatusSnapshot(renderStatusJson(written))).toEqual(written);

		const failed = await buildStatusSnapshot(down, down, options);
		expect(readStatusSnapshot(renderStatusJson(failed))).toEqual(failed);
	});

	it('refuses a report from before a field was added', async () => {
		const written = await buildStatusSnapshot(collected, repos, options);
		if (written.drift.status !== 'ok') throw new Error('expected a report');
		const older: Partial<typeof written.drift.data> = { ...written.drift.data };
		delete older.pins;
		const text = JSON.stringify({ ...written, drift: { status: 'ok', data: older } });
		expect(readStatusSnapshot(text)).toBeNull();
	});

	it('refuses a snapshot from before the repositories were added', async () => {
		const { repos: _repos, ...older } = await buildStatusSnapshot(collected, repos, options);
		expect(_repos.status).toBe('ok');
		expect(readStatusSnapshot(JSON.stringify(older))).toBeNull();
	});

	it('refuses what is not a snapshot at all', () => {
		for (const text of [
			'not json',
			'null',
			'[]',
			'{}',
			'{"org":"o","generatedAt":"d"}',
			'{"org":"o","generatedAt":"d","drift":{"status":"ok"}}',
			'{"org":"o","generatedAt":"d","drift":{"status":"failed"}}',
			'{"org":"o","generatedAt":"d","drift":{"status":"other","data":{}}}',
		]) {
			expect(readStatusSnapshot(text)).toBeNull();
		}
	});
});

describe('renderStatusJson', () => {
	it('writes everything the snapshot holds, ending in a newline', async () => {
		const snapshot = await buildStatusSnapshot(collected, repos, options);
		const json = renderStatusJson(snapshot);
		expect(JSON.parse(json)).toEqual(snapshot);
		expect(json.endsWith('}\n')).toBe(true);
	});
});
