/**
 * Lays the graph out once, at build time, so that the page can ship finished
 * coordinates instead of a megabyte of layout engine.
 */

import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { EDGE_KIND_META, type DependencyLink } from './model';

export interface Point {
	x: number;
	y: number;
}

/** Where a repository's label box goes: its centre, and its size. */
export interface Box extends Point {
	w: number;
	h: number;
}

/** Gap between layers, and between neighbours inside one. */
const RANK_GAP = 90;
const NODE_GAP = 26;

/**
 * Advance widths at the graph's 12px label size in Inter, the site's font, as
 * measured in a browser. There is no browser here to ask, and repository names
 * only use these characters. Adding them up ignores kerning, which overstates a
 * real name by 1.5px at most, and the padding around the label absorbs that.
 * If the label font or size changes, measure these again.
 */
const CHAR_WIDTHS: Record<string, number> = {
	'0': 7.58,
	'1': 4.89,
	'2': 7.33,
	'3': 7.42,
	'4': 7.77,
	'5': 7.3,
	'6': 7.45,
	'7': 6.8,
	'8': 7.44,
	'9': 7.45,
	a: 6.75,
	b: 7.36,
	c: 6.86,
	d: 7.36,
	e: 7,
	f: 4.45,
	g: 7.36,
	h: 7.11,
	i: 2.91,
	j: 3.06,
	k: 6.59,
	l: 2.91,
	m: 10.52,
	n: 7.09,
	o: 7.2,
	p: 7.36,
	q: 7.36,
	r: 4.53,
	s: 6.34,
	t: 3.94,
	u: 7.11,
	v: 6.75,
	w: 9.83,
	x: 6.56,
	y: 6.75,
	z: 6.64,
	'-': 5.53,
	'.': 3.47,
	_: 5.48,
};
/** For anything else, such as a capital: wide, so that the label still fits. */
const UNKNOWN_CHAR_WIDTH = 9;
const LABEL_PADDING_X = 16;
const LABEL_HEIGHT = 25;

/** How wide a repository's label box has to be. */
export function labelWidth(name: string): number {
	let text = 0;
	for (const char of name) text += CHAR_WIDTHS[char] ?? UNKNOWN_CHAR_WIDTH;
	return Math.round(text) + LABEL_PADDING_X;
}

/** One decimal is finer than the eye can tell, and keeps the page payload small. */
function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * How many layouts to try. ELK's crossing reduction is a heuristic, and on this
 * graph its result ranges from 76 to 145 crossings depending on the random seed
 * alone. One layout takes about 35ms, so this costs seconds, at build time only.
 */
const LAYOUT_SEEDS = 100;

/** Whether the interiors of two segments meet in a single point. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
	const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
	if (denominator === 0) return false;
	const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
	const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator;
	return t > 0 && t < 1 && u > 0 && u < 1;
}

/** How often the given routes cross each other. */
export function countCrossings(routes: Point[][]): number {
	let crossings = 0;
	for (let i = 0; i < routes.length; i++) {
		for (let j = i + 1; j < routes.length; j++) {
			for (let s = 1; s < routes[i].length; s++) {
				for (let t = 1; t < routes[j].length; t++) {
					if (segmentsCross(routes[i][s - 1], routes[i][s], routes[j][t - 1], routes[j][t])) {
						crossings++;
					}
				}
			}
		}
	}
	return crossings;
}

/**
 * Lays the graph out with ELK's layered algorithm.
 *
 * It ranks the repositories so every dependency points the same way, orders
 * each rank to cut down on crossings, and routes the edges orthogonally: an
 * edge leaves its source sideways, travels in a channel between the ranks, and
 * comes back in at its target. ELK also gives each edge its own place on a
 * node's border, which is what unpicks the fan of a dozen arrows arriving at
 * one hub — the thing dagre leaves stacked on a single corner.
 *
 * The links arrive free of cycles as long as the data has none: the release
 * triggers that used to close them are already turned around. Should a real
 * cycle appear, ELK breaks it by drawing an arrow of its choice backward.
 *
 * It tries a fixed list of random seeds and keeps the layout with the fewest
 * crossings, the lowest seed winning a tie, so the same data always gives the
 * same picture. Changed data can make another seed win and rearrange the graph.
 */
export async function layoutGraph<Node extends { name: string }>(
	nodes: Node[],
	links: DependencyLink[],
	seeds = LAYOUT_SEEDS,
): Promise<{
	nodes: (Node & Box)[];
	links: (DependencyLink & { points: Point[] })[];
}> {
	const names = new Set(nodes.map((node) => node.name));
	const drawable = links.filter((link) => names.has(link.from) && names.has(link.to));

	const graphWithSeed = (seed: number): ElkNode => ({
		id: 'root',
		layoutOptions: {
			'elk.randomSeed': String(seed),
			'elk.algorithm': 'layered',
			'elk.direction': 'RIGHT',
			'elk.edgeRouting': 'ORTHOGONAL',
			'elk.layered.spacing.nodeNodeBetweenLayers': String(RANK_GAP),
			'elk.spacing.nodeNode': String(NODE_GAP),
			'elk.spacing.edgeEdge': '10',
			'elk.spacing.edgeNode': '18',
			'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
			'elk.layered.spacing.edgeNodeBetweenLayers': '18',
			'elk.layered.cycleBreaking.strategy': 'GREEDY',
			'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
			'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
			// Repositories with nothing to connect to are laid out beside the rest
			// rather than padding out the first rank.
			'elk.separateConnectedComponents': 'true',
			'elk.spacing.componentComponent': '40',
		},
		children: nodes.map((node) => ({
			id: node.name,
			width: labelWidth(node.name),
			height: LABEL_HEIGHT,
		})),
		edges: drawable.map((link, index) => ({
			id: String(index),
			sources: [link.from],
			targets: [link.to],
			// A build-time dependency is worth keeping straight and pointing the
			// right way more than a CI trigger is, so the kind weights carry over.
			layoutOptions: {
				'elk.layered.priority.direction': String(EDGE_KIND_META[link.kinds[0]].weight),
			},
		})),
	});

	const elk = new ELK();
	let best: { placed: ElkNode; routes: Map<number, Point[]>; crossings: number } | undefined;
	for (let seed = 1; seed <= seeds; seed++) {
		const laid = await elk.layout(graphWithSeed(seed));

		const routes = new Map<number, Point[]>();
		for (const edge of laid.edges ?? []) {
			const section = edge.sections?.[0];
			if (!section) continue;
			routes.set(
				Number(edge.id),
				[section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
					({ x, y }) => ({
						x: round(x),
						y: round(y),
					}),
				),
			);
		}

		const crossings = countCrossings([...routes.values()]);
		if (!best || crossings < best.crossings) best = { placed: laid, routes, crossings };
	}
	if (!best) throw new Error('the layout needs at least one seed');
	const { routes } = best;

	const placed = new Map<string, Box>();
	for (const child of best.placed.children ?? []) {
		const w = child.width ?? 0;
		const h = child.height ?? 0;
		// ELK reports the top-left corner; everything else works from centres.
		placed.set(child.id, {
			x: round((child.x ?? 0) + w / 2),
			y: round((child.y ?? 0) + h / 2),
			w,
			h,
		});
	}

	return {
		nodes: nodes.map((node) => {
			const box = placed.get(node.name);
			if (!box) throw new Error(`the layout left out ${node.name}`);
			return { ...node, ...box };
		}),
		links: drawable.map((link, index) => ({ ...link, points: routes.get(index) ?? [] })),
	};
}
