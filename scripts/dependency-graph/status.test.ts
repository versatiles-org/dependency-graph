import { describe, expect, it } from 'vitest';
import { assess, type Usage } from './drift';
import { buildStatusSnapshot, renderStatusJson } from './status';

const now = new Date('2026-11-01T12:00:00Z');

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

describe('buildStatusSnapshot', () => {
	it('records when the data was collected, and the report', async () => {
		const snapshot = await buildStatusSnapshot(collected, now);
		expect(snapshot.generatedAt).toBe('2026-11-01T12:00:00.000Z');
		expect(snapshot.drift).toMatchObject({ status: 'ok', data: { totals: { usages: 2 } } });
	});

	it('passes the rank on to the update order', async () => {
		const snapshot = await buildStatusSnapshot(collected, now, (repo) => (repo === 'b' ? 0 : 1));
		if (snapshot.drift.status !== 'ok') throw new Error('expected a report');
		expect(snapshot.drift.data.dependents.map((entry) => entry.consumer)).toEqual(['b', 'a']);
	});

	it('records a failure instead of passing it on', async () => {
		const snapshot = await buildStatusSnapshot(
			() => Promise.reject(new Error('503 for https://registry.npmjs.org/x')),
			now,
		);
		expect(snapshot).toEqual({
			generatedAt: '2026-11-01T12:00:00.000Z',
			drift: { status: 'failed', error: '503 for https://registry.npmjs.org/x' },
		});
	});
});

describe('renderStatusJson', () => {
	it('writes everything the snapshot holds, ending in a newline', async () => {
		const snapshot = await buildStatusSnapshot(collected, now);
		const json = renderStatusJson(snapshot);
		expect(JSON.parse(json)).toEqual(snapshot);
		expect(json.endsWith('}\n')).toBe(true);
	});
});
