import { describe, expect, it } from 'vitest';
import { labelWidth, layoutGraph } from './layout';
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

	it('comes out the same every time, so a rebuild does not move anything', async () => {
		const again = await layoutGraph(
			[node('app'), node('lib'), node('core'), node('alone')],
			[link('app', 'lib'), link('lib', 'core'), link('app', 'core')],
		);
		expect(again).toEqual(await graph);
	});
});
