import { describe, expect, it } from 'vitest';
import { countCrossings, labelWidth, layoutGraph } from './layout';
import type { DependencyLink } from './model';

const node = (name: string) => ({ name });
const link = (from: string, to: string): DependencyLink => ({ from, to, kinds: ['npm'] });

describe('labelWidth', () => {
	it('adds up the characters, plus padding', () => {
		// 3.94 + 7.2 + 7.2 + 2.91 + 6.34 = 27.59, as measured for "tools" in a browser.
		expect(labelWidth('tools')).toBe(28 + 16);
	});

	it('errs on the wide side for a character it has not measured', () => {
		expect(labelWidth('Tools')).toBeGreaterThan(labelWidth('tools'));
	});
});

describe('countCrossings', () => {
	const route = (...points: [number, number][]) => points.map(([x, y]) => ({ x, y }));

	it('counts routes that cross', () => {
		expect(countCrossings([route([0, 5], [10, 5]), route([5, 0], [5, 10])])).toBe(1);
	});

	it('counts every crossing of a route that bends back', () => {
		expect(
			countCrossings([route([0, 5], [10, 5]), route([2, 0], [2, 10], [8, 10], [8, 0])]),
		).toBe(2);
	});

	it('does not count routes that only touch, or run side by side', () => {
		expect(
			countCrossings([route([0, 0], [10, 0]), route([10, 0], [10, 10]), route([0, 2], [10, 2])]),
		).toBe(0);
	});
});

describe('layoutGraph', () => {
	const graph = layoutGraph(
		[node('app'), node('lib'), node('core'), node('alone')],
		[link('app', 'lib'), link('lib', 'core'), link('app', 'core')],
	);

	it('points every dependency to the right', async () => {
		const { nodes } = await graph;
		const x = (name: string) => nodes.find((entry) => entry.name === name)?.x ?? NaN;
		expect(x('app')).toBeLessThan(x('lib'));
		expect(x('lib')).toBeLessThan(x('core'));
	});

	it('gives each repository a box that fits its label', async () => {
		const { nodes } = await graph;
		for (const entry of nodes) {
			expect(entry.w, entry.name).toBe(labelWidth(entry.name));
			expect(entry.h, entry.name).toBeGreaterThan(12);
		}
	});

	it('keeps a repository without dependencies', async () => {
		const { nodes } = await graph;
		expect(nodes.map((entry) => entry.name)).toContain('alone');
	});

	it('routes every link from its source to its target', async () => {
		const { nodes, links } = await graph;
		expect(links).toHaveLength(3);
		for (const entry of links) {
			const source = nodes.find((candidate) => candidate.name === entry.from);
			const target = nodes.find((candidate) => candidate.name === entry.to);
			const first = entry.points[0];
			const last = entry.points[entry.points.length - 1];
			expect(first.x).toBeCloseTo((source?.x ?? 0) + (source?.w ?? 0) / 2, 0);
			expect(last.x).toBeCloseTo((target?.x ?? 0) - (target?.w ?? 0) / 2, 0);
		}
	});

	it('leaves out a link to a repository that is not in the graph', async () => {
		const { links } = await layoutGraph([node('app')], [link('app', 'gone')]);
		expect(links).toEqual([]);
	});

	it('keeps the seed with the fewest crossings', async () => {
		// Irregular and dense enough for the result to depend on the seed.
		const names = Array.from({ length: 24 }, (_, index) => `n${index}`);
		const links = names.flatMap((from, i) =>
			names.flatMap((to, j) =>
				j > i && Math.imul(i * 31 + j, 2654435761) >>> 28 < 3 ? [link(from, to)] : [],
			),
		);
		const crossings = async (seeds: number) => {
			const result = await layoutGraph(names.map(node), links, seeds);
			return countCrossings(result.links.map((entry) => entry.points));
		};
		expect(await crossings(30)).toBeLessThan(await crossings(1));
	});

	it('comes out the same every time, so a rebuild does not move anything', async () => {
		const again = await layoutGraph(
			[node('app'), node('lib'), node('core'), node('alone')],
			[link('app', 'lib'), link('lib', 'core'), link('app', 'core')],
		);
		expect(again).toEqual(await graph);
	});
});
