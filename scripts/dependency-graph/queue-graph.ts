/**
 * Lays out the outdated dependencies as a lane graph, for the status page.
 *
 * Every package with someone behind on it gets a vertical lane, starting at its
 * own row. A repository connects to a lane with a line along its row that bends
 * up into the lane with a quarter of a circle, so a line that does not bend is
 * only passing. Rows keep the update order, so lines point upwards: what a
 * repository depends on is further up. A cycle is the one exception, and bends
 * downwards instead.
 *
 * A repository in the queue that others use without being behind on it yet gets
 * a lane as well, in grey and with thin dotted lines: they will be behind once it
 * is released, which is why it comes first.
 *
 * It runs in the browser, so it may only import types from `drift.ts`.
 */

import type { OutdatedUsage } from './drift';
import { isDev, type QueueEntry } from './status-view';

const ROW_HEIGHT = 44;
const DETAIL_HEIGHT = 28;
const RELEASES_TOP = 64;
const GROUP_GAP = 32;
/** Where the node of a repository without a lane of its own sits. */
export const NODE_X = 24;
const FIRST_LANE_X = 84;
const LANE_GAP = 52;
const CURVE = 14;
/** Keeps the end of a lane clear of the node it belongs to. */
const LANE_OFFSET = 18;
const HEAD_LENGTH = 9;
const HEAD_HALF_WIDTH = 6;
/** Room right of the last lane for its label. */
const LABEL_ROOM = 96;

export interface GraphDetail extends OutdatedUsage {
	/** Offset of its text within the row. */
	y: number;
	/** The lane it connects to. */
	lane: number;
}

export interface GraphRow {
	repo: string;
	/** Place in the update queue; null for a package nobody has to update itself. */
	position: number | null;
	packages: string;
	top: number;
	height: number;
	/** Height of its centre line, where its node and its lines are. */
	y: number;
	nodeX: number;
	/** Its own lane, when other repositories depend on it. */
	lane: number | null;
	/** One per outdated usage. */
	details: GraphDetail[];
	/** For a package nobody has to update itself. */
	latest: string | null;
	behindCount: number;
}

export interface GraphEdge {
	consumer: string;
	provider: string;
	line: string;
	/** Only development dependencies are behind. */
	dashed: boolean;
	/** Nothing is behind yet, but will be once the provider is released. */
	dotted: boolean;
}

export interface GraphLane {
	repo: string;
	/** Place from the left. */
	index: number;
	/** Colour index, or null for a lane with only dotted lines. */
	color: number | null;
	label: string;
	x: number;
	/** The line of the lane itself, as far as solid lines join it. */
	line: string;
	/** Where it goes on with only dotted lines joining it. */
	dottedLine: string;
	/** The arrowheads pointing at its node. */
	heads: string;
	/** The solid lines of the lane as one path, so that it does not darken where they meet. */
	halo: string;
	edges: GraphEdge[];
}

export interface QueueGraph {
	rows: GraphRow[];
	lanes: GraphLane[];
	/** Width of the graph itself. */
	width: number;
	/** Height of everything, its rows and their group labels. */
	height: number;
	/** Where the label above the rows to update goes. */
	queueLabelTop: number;
	hasReleases: boolean;
}

/** `versatiles-style` becomes `style`, and `maplibre-versatiles-styler` becomes `styler`. */
export function laneLabel(repo: string): string {
	return repo.replace(/^(node-|maplibre-)?versatiles-/, '');
}

/**
 * `waiting` is what `waitingOn` returns: for each repository, the others in the
 * queue it waits for without being behind on them.
 */
export function buildQueueGraph(
	queue: QueueEntry[],
	publishes: Record<string, string[]>,
	waiting: Record<string, string[]> = {},
): QueueGraph {
	// Only what is shown can be waited for.
	const shown = new Set(queue.map((entry) => entry.consumer));
	const waitsFor = (entry: QueueEntry): string[] =>
		(waiting[entry.consumer] ?? []).filter((repo) => shown.has(repo));

	// A lane comes in the order it is first needed, so one that ends early does not
	// have to be passed by what comes after it.
	const providers = [
		...new Set(
			queue.flatMap((entry) =>
				[
					...new Set([...entry.outdated.map((usage) => usage.provider), ...waitsFor(entry)]),
				].sort((a, b) => a.localeCompare(b)),
			),
		),
	];
	const laneIndex = new Map(providers.map((repo, index) => [repo, index]));
	const behindOn = new Set(
		queue.flatMap((entry) => entry.outdated.map((usage) => usage.provider)),
	);
	// Grey lanes take no colour, so that a package keeps its colour whatever else is shown.
	const laneColor = new Map(
		providers.filter((repo) => behindOn.has(repo)).map((repo, index) => [repo, index]),
	);
	const laneX = (index: number): number => FIRST_LANE_X + index * LANE_GAP;

	const inQueue = new Set(queue.map((entry) => entry.consumer));
	const released = providers.filter((repo) => !inQueue.has(repo));
	const usagesOf = (repo: string): OutdatedUsage[] =>
		queue.flatMap((entry) => entry.outdated.filter((usage) => usage.provider === repo));

	const releaseRows = released.map((repo, index): GraphRow => {
		const usages = usagesOf(repo);
		const top = RELEASES_TOP + index * ROW_HEIGHT;
		const lane = laneIndex.get(repo)!;
		return {
			repo,
			position: null,
			packages: [...new Set(usages.map((usage) => usage.name))].join(', '),
			top,
			height: ROW_HEIGHT,
			y: top + ROW_HEIGHT / 2,
			nodeX: laneX(lane),
			lane,
			details: [],
			latest: usages[0]?.latest ?? null,
			behindCount: new Set(usages.map((usage) => usage.consumer)).size,
		};
	});

	const queueLabelTop = released.length > 0 ? RELEASES_TOP + released.length * ROW_HEIGHT + 8 : 40;
	let next = queueLabelTop + GROUP_GAP - 8;
	const queueRows = queue.map((entry): GraphRow => {
		const height = Math.max(ROW_HEIGHT, 16 + entry.outdated.length * DETAIL_HEIGHT);
		const top = next;
		next += height;
		const lane = laneIndex.get(entry.consumer) ?? null;
		return {
			repo: entry.consumer,
			position: entry.position,
			packages: (publishes[entry.consumer] ?? []).join(', ') || 'not published',
			top,
			height,
			y: top + height / 2,
			nodeX: lane === null ? NODE_X : laneX(lane),
			lane,
			details: entry.outdated.map((usage, index) => ({
				...usage,
				y:
					entry.outdated.length === 1
						? height / 2
						: height / 2 + (index - (entry.outdated.length - 1) / 2) * DETAIL_HEIGHT,
				lane: laneIndex.get(usage.provider)!,
			})),
			latest: null,
			behindCount: 0,
		};
	});

	const rows = [...releaseRows, ...queueRows];
	const rowOf = new Map(rows.map((row) => [row.repo, row]));

	const lanes = providers.map((repo, index): GraphLane => {
		const x = laneX(index);
		const own = rowOf.get(repo)!;

		// Several packages of one repository still make one line to its lane.
		const edges = queue.flatMap((entry): GraphEdge[] => {
			const usages = entry.outdated.filter((usage) => usage.provider === repo);
			const waits = waitsFor(entry).includes(repo);
			if (usages.length === 0 && !waits) return [];
			const row = rowOf.get(entry.consumer)!;
			return [
				{
					consumer: entry.consumer,
					provider: repo,
					line: edgeLine(row.nodeX, x, row.y, own.y),
					dashed: usages.length > 0 && usages.every((usage) => isDev(usage)),
					dotted: usages.length === 0,
				},
			];
		});

		const solid: string[] = [];
		const dotted: string[] = [];
		const heads: string[] = [];
		// Only a cycle has lines from above its own row.
		for (const direction of [1, -1] as const) {
			const ends = edges
				.map((edge) => ({ edge, y: rowOf.get(edge.consumer)!.y }))
				.filter(({ y }) => (y - own.y) * direction > 0)
				.map(({ edge, y }) => ({ dotted: edge.dotted, y: y - direction * CURVE }));
			if (ends.length === 0) continue;
			const start = own.y + direction * LANE_OFFSET;
			const furthest = (list: typeof ends): number =>
				Math.max(...list.map(({ y }) => y * direction)) * direction;
			const solidEnds = ends.filter((end) => !end.dotted);
			const turn = solidEnds.length > 0 ? furthest(solidEnds) : start;
			if (solidEnds.length > 0) solid.push(`M ${x} ${start} L ${x} ${turn}`);
			const end = furthest(ends);
			if ((end - turn) * direction > 0) dotted.push(`M ${x} ${turn} L ${x} ${end}`);
			heads.push(head(x, start, direction === 1 ? -1 : 1, solidEnds.length === 0 ? 0.6 : 1));
		}
		const line = solid.join(' ');
		return {
			repo,
			index,
			color: laneColor.get(repo) ?? null,
			label: laneLabel(repo),
			x,
			line,
			dottedLine: dotted.join(' '),
			heads: heads.join(' '),
			halo: [line, ...edges.filter((edge) => !edge.dotted).map((edge) => edge.line)]
				.filter(Boolean)
				.join(' '),
			edges,
		};
	});

	return {
		rows,
		lanes,
		width: (providers.length > 0 ? laneX(providers.length - 1) : NODE_X) + LABEL_ROOM,
		height: next,
		queueLabelTop,
		hasReleases: released.length > 0,
	};
}

/** Along the row from a node, then a quarter of a circle into the lane. */
function edgeLine(fromX: number, laneX: number, y: number, laneY: number): string {
	const right = laneX > fromX;
	const up = laneY < y;
	const sweep = right === up ? 0 : 1;
	const beforeLane = right ? laneX - CURVE : laneX + CURVE;
	const onLane = up ? y - CURVE : y + CURVE;
	return `M ${fromX} ${y} L ${beforeLane} ${y} A ${CURVE} ${CURVE} 0 0 ${sweep} ${laneX} ${onLane}`;
}

/** An arrowhead with its base at `y`, pointing up (-1) or down (1) along a lane. */
function head(x: number, y: number, direction: -1 | 1, scale = 1): string {
	const tip = y + direction * HEAD_LENGTH * scale;
	const half = HEAD_HALF_WIDTH * scale;
	return `M ${x - half} ${y} L ${x} ${tip} L ${x + half} ${y} Z`;
}
