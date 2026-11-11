/**
 * Lays out the outdated dependencies as a lane graph, for the status page.
 *
 * Every package with someone behind on it gets a vertical lane, starting at its
 * own row. A repository connects to a lane with a line along its row that bends
 * up into the lane with a quarter of a circle, so a line that does not bend is
 * only passing. Each line starts at a dot of its own, in its lane's colour and
 * level with the usage it stands for, so the lines of one row never share a
 * path. Rows keep the update order, so lines point upwards: what a repository
 * depends on is further up. A cycle is the one exception, and bends downwards
 * instead.
 *
 * Two things are told apart, independently: a thick line is behind now, a thin
 * one waits, and will be behind once its package is released; dots mean only
 * development tooling, which never reaches released code. A repository in the
 * queue that others only wait for gets a lane as well, in grey.
 *
 * It runs in the browser, so it may only import types from `drift.ts`.
 */

import type { OutdatedUsage } from './drift';
import type { QueueEntry, Wait } from './status-view';

/** The sizes of a layout, which the page reads as well. */
export interface GraphMetrics {
	/**
	 * Whether the text of a row stacks right of the lanes, under its name, instead
	 * of standing in columns of its own.
	 */
	stacked: boolean;
	/** Height of a row without usages, and the least any row gets. */
	rowHeight: number;
	/** Room per outdated usage in a row. */
	detailHeight: number;
	/** Room a row needs besides its usages. */
	rowBase: number;
	/** Where the usages of a stacked row start, below its name. */
	detailsTop: number;
	/** Where the label above the first group of rows goes. */
	firstLabelTop: number;
	/** Where the rows of packages with a newer release start. */
	releasesTop: number;
	/** From the label above the rows to update to the first of them, plus 8. */
	groupGap: number;
	/** Height of the node within its row, or null for the middle of the row. */
	nodeTop: number | null;
	nodeRadius: number;
	/** Of the dot each line of a row starts at, in the colour of that line. */
	dotRadius: number;
	/** Where the node of a repository without a lane of its own sits. */
	nodeX: number;
	firstLaneX: number;
	laneGap: number;
	curve: number;
	/** Keeps the end of a lane clear of the node it belongs to. */
	laneOffset: number;
	headLength: number;
	headHalfWidth: number;
	/** Room right of the last lane, for its label or as a gap before the text. */
	labelRoom: number;
}

/** Columns side by side, scrolling sideways where the screen is narrower. */
export const WIDE: GraphMetrics = {
	stacked: false,
	rowHeight: 44,
	detailHeight: 28,
	rowBase: 16,
	detailsTop: 0,
	firstLabelTop: 40,
	releasesTop: 64,
	groupGap: 32,
	nodeTop: null,
	nodeRadius: 7,
	dotRadius: 5,
	nodeX: 24,
	firstLaneX: 84,
	laneGap: 52,
	curve: 14,
	laneOffset: 18,
	headLength: 9,
	headHalfWidth: 6,
	labelRoom: 96,
};

/**
 * For phones, where nothing may scroll sideways. The eight lanes the queue can
 * have end 140 pixels in, which leaves a 390-pixel phone about 200 for the text:
 * enough for the longest name. A row is a name line and a line of packages, then
 * two lines per usage, each 18 high; the node sits on the name line, so that the
 * lines meet the row where the reader looks for it.
 */
export const NARROW: GraphMetrics = {
	stacked: true,
	rowHeight: 86,
	detailHeight: 36,
	rowBase: 50,
	detailsTop: 44,
	firstLabelTop: 0,
	releasesTop: 40,
	groupGap: 48,
	nodeTop: 13,
	nodeRadius: 5,
	dotRadius: 4,
	nodeX: 10,
	firstLaneX: 30,
	laneGap: 14,
	curve: 7,
	laneOffset: 14,
	headLength: 7,
	headHalfWidth: 4.5,
	labelRoom: 12,
};

export interface GraphDetail extends OutdatedUsage {
	/** Offset of its text within the row. */
	y: number;
	/** The lane it connects to. */
	lane: number;
}

/** A line for a repository the row waits for without being behind on it yet. */
export interface GraphWait {
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
	/** One per repository it waits for, after the details. */
	waits: GraphWait[];
	/** For a package nobody has to update itself. */
	latest: string | null;
	behindCount: number;
}

export interface GraphEdge {
	consumer: string;
	provider: string;
	line: string;
	/**
	 * Where the line starts, with a dot of its own: level with the first usage it
	 * stands for, so that lines of one row never share a path.
	 */
	x: number;
	y: number;
	/**
	 * Only development tooling is behind, or waits, which never reaches released
	 * code. Drawn as dots.
	 */
	tooling: boolean;
	/** Nothing is behind yet, but will be once the provider is released. Drawn thin. */
	waiting: boolean;
}

export interface GraphLane {
	repo: string;
	/** Place from the left. */
	index: number;
	/** Colour index, or null for a lane with only waiting lines. */
	color: number | null;
	label: string;
	x: number;
	/**
	 * The lane itself, in four parts. Each is drawn like the lines it leads to,
	 * and goes as far as the last of them: so a lane only tooling is behind on is
	 * dotted all the way. First as far as lines that are behind and ship join it.
	 */
	line: string;
	/** Then as far as lines that are behind on tooling join it. */
	toolingLine: string;
	/** Then as far as waiting lines that ship join it. */
	waitingLine: string;
	/** Then as far as waiting lines on tooling join it. */
	waitingToolingLine: string;
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
	waiting: Record<string, Wait[]> = {},
	metrics: GraphMetrics = WIDE,
): QueueGraph {
	const m = metrics;
	const centre = (top: number, height: number): number =>
		top + (m.nodeTop === null ? height / 2 : m.nodeTop);
	// Only what is shown can be waited for.
	const shown = new Set(queue.map((entry) => entry.consumer));
	const waitsFor = (entry: QueueEntry): Wait[] =>
		(waiting[entry.consumer] ?? []).filter((wait) => shown.has(wait.provider));

	// A lane comes in the order it is first needed, so one that ends early does not
	// have to be passed by what comes after it.
	const providers = [
		...new Set(
			queue.flatMap((entry) =>
				[
					...new Set([
						...entry.outdated.map((usage) => usage.provider),
						...waitsFor(entry).map((wait) => wait.provider),
					]),
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
	const laneX = (index: number): number => m.firstLaneX + index * m.laneGap;

	const inQueue = new Set(queue.map((entry) => entry.consumer));
	const released = providers.filter((repo) => !inQueue.has(repo));
	const usagesOf = (repo: string): OutdatedUsage[] =>
		queue.flatMap((entry) => entry.outdated.filter((usage) => usage.provider === repo));

	const releaseRows = released.map((repo, index): GraphRow => {
		const usages = usagesOf(repo);
		const top = m.releasesTop + index * m.rowHeight;
		const lane = laneIndex.get(repo)!;
		return {
			repo,
			position: null,
			packages: [...new Set(usages.map((usage) => usage.name))].join(', '),
			top,
			height: m.rowHeight,
			y: centre(top, m.rowHeight),
			nodeX: laneX(lane),
			lane,
			details: [],
			waits: [],
			latest: usages[0]?.latest ?? null,
			behindCount: new Set(usages.map((usage) => usage.consumer)).size,
		};
	});

	const queueLabelTop =
		released.length > 0 ? m.releasesTop + released.length * m.rowHeight + 8 : m.firstLabelTop;
	let next = queueLabelTop + m.groupGap - 8;
	const queueRows = queue.map((entry): GraphRow => {
		// What it only waits for gets a line of its own, after what it is behind on.
		const behind = new Set(entry.outdated.map((usage) => usage.provider));
		const waits = waitsFor(entry)
			.map((wait) => wait.provider)
			.filter((repo) => !behind.has(repo))
			.sort((a, b) => laneIndex.get(a)! - laneIndex.get(b)!);
		const slots = entry.outdated.length + waits.length;
		const height = Math.max(m.rowHeight, m.rowBase + slots * m.detailHeight);
		const top = next;
		next += height;
		const lane = laneIndex.get(entry.consumer) ?? null;
		// Stacked, a usage starts below the name, at the middle of its first line;
		// otherwise the usages spread around the middle of the row.
		const detailY = (index: number): number =>
			m.stacked
				? m.detailsTop + index * m.detailHeight + m.detailHeight / 4
				: height / 2 + (index - (slots - 1) / 2) * m.detailHeight;
		return {
			repo: entry.consumer,
			position: entry.position,
			packages: (publishes[entry.consumer] ?? []).join(', ') || 'not published',
			top,
			height,
			y: centre(top, height),
			nodeX: lane === null ? m.nodeX : laneX(lane),
			lane,
			// In the order of their lanes, so that no line of a row crosses another.
			details: entry.outdated
				.map((usage) => ({ ...usage, lane: laneIndex.get(usage.provider)! }))
				.sort((a, b) => a.lane - b.lane)
				.map((detail, index) => ({ ...detail, y: detailY(index) })),
			waits: waits.map((repo, index) => ({
				y: detailY(entry.outdated.length + index),
				lane: laneIndex.get(repo)!,
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
			const wait = waitsFor(entry).find((each) => each.provider === repo);
			if (usages.length === 0 && !wait) return [];
			const row = rowOf.get(entry.consumer)!;
			const slot =
				row.details.find((detail) => detail.provider === repo)?.y ??
				row.waits.find((wait) => wait.lane === index)!.y;
			const from = { x: m.nodeX, y: row.top + slot };
			return [
				{
					consumer: entry.consumer,
					provider: repo,
					line: edgeLine(from.x, x, from.y, own.y, m.curve),
					...from,
					tooling: usages.length > 0 ? usages.every((usage) => usage.tooling) : wait!.tooling,
					waiting: usages.length === 0,
				},
			];
		});

		// Strongest first: behind and shipping, behind on tooling, waiting, waiting on tooling.
		const parts: string[][] = [[], [], [], []];
		const strength = (edge: GraphEdge): number => (edge.waiting ? 2 : 0) + (edge.tooling ? 1 : 0);
		const heads: string[] = [];
		// Only a cycle has lines from above its own row.
		for (const direction of [1, -1] as const) {
			const ends = edges
				.map((edge) => ({ edge, y: edge.y }))
				.filter(({ y }) => (y - own.y) * direction > 0)
				.map(({ edge, y }) => ({ edge, y: y - direction * m.curve }));
			if (ends.length === 0) continue;
			const start = own.y + direction * m.laneOffset;
			// Each part of the lane is drawn like the strongest line still to join it.
			const reach = (list: typeof ends): number =>
				list.length > 0 ? Math.max(...list.map(({ y }) => y * direction)) * direction : start;
			const segment = (from: number, to: number, into: string[]): void => {
				if ((to - from) * direction > 0) into.push(`M ${x} ${from} L ${x} ${to}`);
			};
			let from = start;
			parts.forEach((part, rank) => {
				const to = reach(ends.filter(({ edge }) => strength(edge) <= rank));
				segment(from, to, part);
				if ((to - from) * direction > 0) from = to;
			});
			const behind = ends.some(({ edge }) => !edge.waiting);
			heads.push(head(m, x, start, direction === 1 ? -1 : 1, behind ? 1 : 0.6));
		}
		const [line, toolingLine, waitingLine, waitingToolingLine] = parts.map((part) =>
			part.join(' '),
		);
		return {
			repo,
			index,
			color: laneColor.get(repo) ?? null,
			label: laneLabel(repo),
			x,
			line,
			toolingLine,
			waitingLine,
			waitingToolingLine,
			heads: heads.join(' '),
			// Only what is behind and ships: under dots, a halo would fill the gaps between them.
			halo: [line, ...edges.filter((edge) => strength(edge) === 0).map((edge) => edge.line)]
				.filter(Boolean)
				.join(' '),
			edges,
		};
	});

	return {
		rows,
		lanes,
		width: (providers.length > 0 ? laneX(providers.length - 1) : m.nodeX) + m.labelRoom,
		height: next,
		queueLabelTop,
		hasReleases: released.length > 0,
	};
}

/**
 * Along the row from its dot, then a quarter of a circle into the lane. Every
 * line starts left of every lane, so it only bends up or, in a cycle, down.
 */
function edgeLine(fromX: number, laneX: number, y: number, laneY: number, curve: number): string {
	const up = laneY < y;
	const sweep = up ? 0 : 1;
	const onLane = up ? y - curve : y + curve;
	return `M ${fromX} ${y} L ${laneX - curve} ${y} A ${curve} ${curve} 0 0 ${sweep} ${laneX} ${onLane}`;
}

/** An arrowhead with its base at `y`, pointing up (-1) or down (1) along a lane. */
function head(m: GraphMetrics, x: number, y: number, direction: -1 | 1, scale = 1): string {
	const tip = y + direction * m.headLength * scale;
	const half = m.headHalfWidth * scale;
	return `M ${x - half} ${y} L ${x} ${tip} L ${x + half} ${y} Z`;
}
