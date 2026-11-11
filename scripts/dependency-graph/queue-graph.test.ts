import { describe, expect, it } from 'vitest';
import type { OutdatedUsage } from './drift';
import { buildQueueGraph, laneLabel, NARROW, WIDE } from './queue-graph';
import type { QueueEntry } from './status-view';

const usage = (consumer: string, provider: string, overrides: Partial<OutdatedUsage> = {}) =>
	({
		ecosystem: 'npm',
		name: `@versatiles/${provider}`,
		provider,
		consumer,
		path: 'package.json',
		section: 'dependencies',
		tooling: false,
		requested: '^1.0.0',
		installed: '1.0.0',
		lockPath: 'package-lock.json',
		status: 'stale-lock',
		behind: 'minor',
		note: '',
		fix: null,
		latest: '1.1.0',
		...overrides,
	}) satisfies OutdatedUsage;

const entry = (position: number, consumer: string, ...outdated: OutdatedUsage[]): QueueEntry => ({
	consumer,
	position,
	outdated,
});

describe('laneLabel', () => {
	it('shortens a repository to what sets it apart', () => {
		expect(laneLabel('versatiles-style')).toBe('style');
		expect(laneLabel('versatiles-rs')).toBe('rs');
		expect(laneLabel('maplibre-versatiles-styler')).toBe('styler');
		expect(laneLabel('node-versatiles-container')).toBe('container');
		expect(laneLabel('tools')).toBe('tools');
	});
});

describe('buildQueueGraph', () => {
	const queue = [
		entry(1, 'server', usage('server', 'style')),
		entry(4, 'choro', usage('choro', 'style'), usage('choro', 'rs')),
		entry(9, 'tools', usage('tools', 'container', { section: 'devDependencies' })),
	];

	it('gives each package a row of its own above the queue, and a lane as it is first needed', () => {
		const graph = buildQueueGraph(queue, {});
		expect(graph.lanes.map((lane) => lane.repo)).toEqual(['style', 'rs', 'container']);
		expect(graph.rows.map((row) => [row.repo, row.position])).toEqual([
			['style', null],
			['rs', null],
			['container', null],
			['server', 1],
			['choro', 4],
			['tools', 9],
		]);
		expect(graph.hasReleases).toBe(true);
	});

	it('says what a release is and how many repositories are behind on it', () => {
		const graph = buildQueueGraph([...queue, entry(10, 'other', usage('other', 'style'))], {});
		expect(graph.rows[0]).toMatchObject({
			repo: 'style',
			packages: '@versatiles/style',
			latest: '1.1.0',
			behindCount: 3,
		});
	});

	it('names what a repository publishes, or says that it publishes nothing', () => {
		const { rows } = buildQueueGraph(queue, { server: ['@versatiles/server'] });
		expect(rows.find((row) => row.repo === 'server')?.packages).toBe('@versatiles/server');
		expect(rows.find((row) => row.repo === 'tools')?.packages).toBe('not published');
	});

	it('bends a line up into a lane to the right of its node', () => {
		const graph = buildQueueGraph([entry(1, 'server', usage('server', 'style'))], {});
		const [release, server] = graph.rows;
		const [lane] = graph.lanes;
		expect(lane.edges[0].line).toBe(
			`M ${WIDE.nodeX} ${server.y} L ${lane.x - 14} ${server.y} A 14 14 0 0 0 ${lane.x} ${server.y - 14}`,
		);
		// The lane ends where the curve arrives, and points at the node of its package.
		expect(lane.line).toBe(`M ${lane.x} ${release.y + 18} L ${lane.x} ${server.y - 14}`);
		expect(lane.heads).toContain(`L ${lane.x} ${release.y + 9} `);
	});

	it('gives a halo every connection of a lane, as one path', () => {
		const graph = buildQueueGraph(queue, {});
		const [style] = graph.lanes;
		expect(style.edges).toHaveLength(2);
		for (const part of [style.line, ...style.edges.map((edge) => edge.line)]) {
			expect(style.halo).toContain(part);
		}
	});

	it('leaves a line from a repository to each lane, even when several packages share one', () => {
		const graph = buildQueueGraph(
			[
				entry(
					1,
					'studio',
					usage('studio', 'rs', { name: 'versatiles_core' }),
					usage('studio', 'rs', { name: 'versatiles_image' }),
				),
			],
			{},
		);
		expect(graph.lanes[0].edges).toHaveLength(1);
		expect(graph.rows[0].packages).toBe('versatiles_core, versatiles_image');
		expect(graph.rows[1].details).toHaveLength(2);
	});

	it('marks a line as tooling only when everything on it is development tooling', () => {
		const tooling = { section: 'devDependencies', tooling: true };
		const lines = (...usages: OutdatedUsage[]) =>
			buildQueueGraph([entry(1, 'a', ...usages)], {}).lanes[0].edges[0].tooling;
		expect(lines(usage('a', 'p', tooling))).toBe(true);
		expect(lines(usage('a', 'p', tooling), usage('a', 'p', { name: 'other' }))).toBe(false);
		// A development dependency that is bundled ships, so its line stays solid.
		expect(lines(usage('a', 'p', { section: 'devDependencies' }))).toBe(false);
	});

	it('gives a tooling line no halo, which would fill the gaps between its dots', () => {
		const [lane] = buildQueueGraph(
			[entry(1, 'a', usage('a', 'p', { section: 'devDependencies', tooling: true }))],
			{},
		).lanes;
		expect(lane.edges[0].tooling).toBe(true);
		expect(lane.halo).not.toContain(lane.edges[0].line);
	});

	it('makes room for every usage in a row, and spreads them around its centre', () => {
		const { rows } = buildQueueGraph(queue, {});
		const choro = rows.find((row) => row.repo === 'choro')!;
		expect(choro.height).toBe(72);
		expect(choro.details.map((detail) => detail.y)).toEqual([22, 50]);
		expect(rows.find((row) => row.repo === 'server')!.details[0].y).toBe(22);
	});

	it('remembers which lane each usage belongs to', () => {
		const { rows } = buildQueueGraph(queue, {});
		const choro = rows.find((row) => row.repo === 'choro')!;
		expect(choro.details.map((detail) => detail.lane)).toEqual([0, 1]);
	});

	describe('with a dependency of a dependency', () => {
		const chain = [
			entry(1, 'styler', usage('styler', 'style')),
			entry(2, 'frontend', usage('frontend', 'style'), usage('frontend', 'styler')),
		];

		it('starts the lane at the row of the repository in the queue', () => {
			const graph = buildQueueGraph(chain, {});
			expect(graph.rows.map((row) => row.repo)).toEqual(['style', 'styler', 'frontend']);
			const styler = graph.rows[1];
			const stylerLane = graph.lanes[1];
			expect(stylerLane.repo).toBe('styler');
			expect(styler).toMatchObject({ position: 1, lane: 1, nodeX: stylerLane.x });
			expect(stylerLane.line.startsWith(`M ${stylerLane.x} ${styler.y + 18} `)).toBe(true);
		});

		it('bends a line from a node right of the lane the other way', () => {
			const graph = buildQueueGraph(chain, {});
			const [release, styler] = graph.rows;
			expect(release.repo).toBe('style');
			const [style, stylerLane] = graph.lanes;
			const line = style.edges.find((edge) => edge.consumer === 'styler')!.line;
			expect(line).toBe(
				`M ${stylerLane.x} ${styler.y} L ${style.x + 14} ${styler.y} A 14 14 0 0 1 ${style.x} ${styler.y - 14}`,
			);
		});

		it('connects a repository depending on both to both', () => {
			const graph = buildQueueGraph(chain, {});
			expect(graph.lanes.map((lane) => lane.edges.map((edge) => edge.consumer))).toEqual([
				['styler', 'frontend'],
				['frontend'],
			]);
		});
	});

	describe('with a cycle', () => {
		it('still draws the line that has to point downwards', () => {
			const cycle = [entry(1, 'a', usage('a', 'b')), entry(2, 'b', usage('b', 'a'))];
			const graph = buildQueueGraph(cycle, {});
			const [a, b] = graph.rows;
			const laneB = graph.lanes.find((lane) => lane.repo === 'b')!;
			// a sits above the row of b, and bends down into its lane.
			expect(laneB.edges[0].line).toContain(`${laneB.x} ${a.y + 14}`);
			expect(laneB.line).toContain(`M ${laneB.x} ${b.y - 18} L ${laneB.x} ${a.y + 14}`);
			expect(graph.hasReleases).toBe(false);
		});
	});

	describe('with a repository waiting for another', () => {
		const waiting = [
			entry(1, 'container', usage('container', 'x')),
			entry(2, 'server', usage('server', 'style')),
			entry(3, 'tools', usage('tools', 'container')),
		];

		it('connects it to the lane of the other with a dotted line', () => {
			const graph = buildQueueGraph(
				[
					entry(1, 'container', usage('container', 'x')),
					entry(2, 'server', usage('server', 'container')),
					entry(3, 'tools', usage('tools', 'style')),
				],
				{},
				{ tools: ['container'] },
			);
			const lane = graph.lanes.find((each) => each.repo === 'container')!;
			expect(lane.edges.map((edge) => [edge.consumer, edge.dotted])).toEqual([
				['server', false],
				['tools', true],
			]);
			expect(lane.color).not.toBeNull();
			// The lane is solid as far as a solid line joins it, and dotted after that.
			const y = (repo: string) => graph.rows.find((row) => row.repo === repo)!.y;
			const [container, server, tools] = ['container', 'server', 'tools'].map(y);
			expect(lane.line).toBe(`M ${lane.x} ${container + 18} L ${lane.x} ${server - 14}`);
			expect(lane.dottedLine).toBe(`M ${lane.x} ${server - 14} L ${lane.x} ${tools - 14}`);
			// Only solid lines are highlighted.
			expect(lane.halo).toContain(lane.edges[0].line);
			expect(lane.halo).not.toContain(lane.edges[1].line);
		});

		it('gives a lane with only dotted lines no colour, and keeps the others in theirs', () => {
			const graph = buildQueueGraph(waiting.slice(0, 2), {}, { server: ['container'] });
			expect(graph.lanes.map((lane) => [lane.repo, lane.color])).toEqual([
				['x', 0],
				['container', null],
				['style', 1],
			]);
			const lane = graph.lanes[1];
			const y = (repo: string) => graph.rows.find((row) => row.repo === repo)!.y;
			const [container, server] = ['container', 'server'].map(y);
			expect(lane.line).toBe('');
			expect(lane.dottedLine).toBe(`M ${lane.x} ${container + 18} L ${lane.x} ${server - 14}`);
			expect(lane.halo).toBe('');
			// A smaller arrowhead, to suit the thin lines.
			expect(lane.heads).toContain(`L ${lane.x} ${container + 18 - 5.4} `);
		});

		it('ignores a repository that is not shown', () => {
			const graph = buildQueueGraph(waiting.slice(1, 2), {}, { server: ['container'] });
			expect(graph.lanes.map((lane) => lane.repo)).toEqual(['style']);
		});
	});

	it('copes with nothing to show', () => {
		expect(buildQueueGraph([], {})).toMatchObject({ rows: [], lanes: [] });
	});

	describe('stacked, for phones', () => {
		const narrow = (entries: QueueEntry[]) => buildQueueGraph(entries, {}, {}, NARROW);

		it('fits the eight lanes the queue can have into 140 pixels, leaving 200 for the text', () => {
			const providers = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
			const graph = narrow(
				providers.map((p, i) => entry(i + 1, `user-${p}`, usage(`user-${p}`, p))),
			);
			expect(graph.lanes).toHaveLength(8);
			expect(graph.width).toBeLessThanOrEqual(140);
			// A 390-pixel phone leaves 342 between the margins of the page.
			expect(342 - graph.width).toBeGreaterThanOrEqual(200);
		});

		it('puts the node on the name line, and two lines per usage below the name', () => {
			const { rows } = narrow(queue);
			const choro = rows.find((row) => row.repo === 'choro')!;
			expect(choro.y - choro.top).toBe(NARROW.nodeTop);
			expect(choro.height).toBe(NARROW.rowBase + 2 * NARROW.detailHeight);
			expect(choro.details.map((detail) => detail.y)).toEqual([53, 89]);
			// Within a group, every row ends where the next one starts.
			for (const group of [rows.slice(0, 3), rows.slice(3)]) {
				for (let i = 1; i < group.length; i++) {
					expect(group[i].top).toBe(group[i - 1].top + group[i - 1].height);
				}
			}
		});

		it('labels each group above its rows, with room for two lines', () => {
			const graph = narrow(queue);
			const [firstRelease] = graph.rows;
			const firstQueued = graph.rows[3];
			expect(firstRelease.top).toBe(NARROW.releasesTop);
			expect(graph.queueLabelTop).toBe(NARROW.releasesTop + 3 * NARROW.rowHeight + 8);
			expect(firstQueued.top).toBe(graph.queueLabelTop + 40);
		});

		it('draws smaller curves and arrowheads to suit the closer lanes', () => {
			const graph = narrow([entry(1, 'server', usage('server', 'style'))]);
			const [release, server] = graph.rows;
			const [lane] = graph.lanes;
			expect(lane.edges[0].line).toBe(
				`M ${NARROW.nodeX} ${server.y} L ${lane.x - 7} ${server.y} A 7 7 0 0 0 ${lane.x} ${server.y - 7}`,
			);
			expect(lane.line).toBe(`M ${lane.x} ${release.y + 14} L ${lane.x} ${server.y - 7}`);
			expect(lane.heads).toContain(`L ${lane.x} ${release.y + 7} `);
		});
	});
});
