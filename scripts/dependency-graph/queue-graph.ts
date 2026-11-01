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
	dashed: boolean;
}

export interface GraphLane {
	repo: string;
	/** Colour index, and place from the left. */
	index: number;
	label: string;
	x: number;
	/** The line of the lane itself. */
	line: string;
	/** The arrowheads pointing at its node. */
	heads: string;
	/** The lane and all of its connections as one path, so that it does not darken where they meet. */
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

export function buildQueueGraph(
	queue: QueueEntry[],
	publishes: Record<string, string[]>,
): QueueGraph {
	// A lane comes in the order it is first needed, so one that ends early does not
	// have to be passed by what comes after it.
	const providers = [
		...new Set(
			queue.flatMap((entry) =>
				[...new Set(entry.outdated.map((usage) => usage.provider))].sort((a, b) =>
					a.localeCompare(b),
				),
			),
		),
	];
	const laneIndex = new Map(providers.map((repo, index) => [repo, index]));
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
			if (usages.length === 0) return [];
			const row = rowOf.get(entry.consumer)!;
			return [
				{
					consumer: entry.consumer,
					provider: repo,
					line: edgeLine(row.nodeX, x, row.y, own.y),
					dashed: usages.every((usage) => isDev(usage)),
				},
			];
		});

		const ys = edges.map((edge) => rowOf.get(edge.consumer)!.y);
		const below = ys.filter((y) => y > own.y);
		const above = ys.filter((y) => y < own.y);
		const parts: string[] = [];
		const heads: string[] = [];
		if (below.length > 0) {
			const start = own.y + LANE_OFFSET;
			parts.push(`M ${x} ${start} L ${x} ${Math.max(...below) - CURVE}`);
			heads.push(head(x, start, -1));
		}
		// Only a cycle has lines from above its own row.
		if (above.length > 0) {
			const start = own.y - LANE_OFFSET;
			parts.push(`M ${x} ${start} L ${x} ${Math.min(...above) + CURVE}`);
			heads.push(head(x, start, 1));
		}
		const line = parts.join(' ');
		return {
			repo,
			index,
			label: laneLabel(repo),
			x,
			line,
			heads: heads.join(' '),
			halo: [line, ...edges.map((edge) => edge.line)].join(' '),
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
function head(x: number, y: number, direction: -1 | 1): string {
	const tip = y + direction * HEAD_LENGTH;
	return `M ${x - HEAD_HALF_WIDTH} ${y} L ${x} ${tip} L ${x + HEAD_HALF_WIDTH} ${y} Z`;
}
