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
	/** Where the dots sit that the lines of a row start at, left of every lane. */
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

/** How a line is drawn, as a line from a row and as a part of a lane. */
export interface LineStyle {
	/** Nothing is behind yet, but will be once the provider is released. Drawn thin. */
	waiting: boolean;
	/**
	 * Only development tooling is behind, or waits, which never reaches released
	 * code. Drawn as dots.
	 */
	tooling: boolean;
}

/** Strongest first: a part of a lane is drawn like the strongest line still to join it. */
const STYLES: readonly LineStyle[] = [
	{ waiting: false, tooling: false },
	{ waiting: false, tooling: true },
	{ waiting: true, tooling: false },
	{ waiting: true, tooling: true },
];

const rank = (style: LineStyle): number =>
	STYLES.findIndex((each) => each.waiting === style.waiting && each.tooling === style.tooling);

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
	/** Height of its node, on its own lane. */
	y: number;
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

export interface GraphEdge extends LineStyle {
	consumer: string;
	provider: string;
	line: string;
	/**
	 * Height of the dot the line starts at, at `nodeX`: level with the first usage
	 * it stands for, so that the lines of one row never share a path.
	 */
	y: number;
}

export interface LanePart extends LineStyle {
	d: string;
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
	 * The lane itself, in up to four parts from its node outwards, strongest
	 * first. Each is drawn like the lines it leads to and goes as far as the last
	 * of them, so a lane only tooling is behind on is dotted all the way.
	 */
	parts: LanePart[];
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
	/** Every line from a row in the queue to a lane, in the order of the rows. */
	const lines: (LineStyle & { consumer: string; lane: number; y: number })[] = [];
	const queueRows = queue.map((entry): GraphRow => {
		// What it only waits for gets a line of its own, after what it is behind on.
		const behind = new Set(entry.outdated.map((usage) => usage.provider));
		const waits = waitsFor(entry)
			.filter((wait) => !behind.has(wait.provider))
			.map((wait) => ({ ...wait, lane: laneIndex.get(wait.provider)! }))
			.sort((a, b) => a.lane - b.lane);
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
		// In the order of their lanes, so that no line of a row crosses another.
		const details = entry.outdated
			.map((usage) => ({ ...usage, lane: laneIndex.get(usage.provider)! }))
			.sort((a, b) => a.lane - b.lane)
			.map((detail, index) => ({ ...detail, y: detailY(index) }));
		const rowWaits = waits.map(({ lane: waitLane }, index) => ({
			y: detailY(entry.outdated.length + index),
			lane: waitLane,
		}));

		// Several packages of one repository still make one line to its lane, level with the first.
		for (const usageLane of new Set(details.map((detail) => detail.lane))) {
			const usages = details.filter((detail) => detail.lane === usageLane);
			lines.push({
				consumer: entry.consumer,
				lane: usageLane,
				y: top + usages[0].y,
				waiting: false,
				tooling: usages.every((usage) => usage.tooling),
			});
		}
		waits.forEach((wait, index) => {
			lines.push({
				consumer: entry.consumer,
				lane: wait.lane,
				y: top + rowWaits[index].y,
				waiting: true,
				tooling: wait.tooling,
			});
		});

		return {
			repo: entry.consumer,
			position: entry.position,
			packages: (publishes[entry.consumer] ?? []).join(', ') || 'not published',
			top,
			height,
			y: centre(top, height),
			lane,
			details,
			waits: rowWaits,
			latest: null,
			behindCount: 0,
		};
	});

	const rows = [...releaseRows, ...queueRows];
	const rowOf = new Map(rows.map((row) => [row.repo, row]));

	const lanes = providers.map((repo, index): GraphLane => {
		const x = laneX(index);
		const own = rowOf.get(repo)!;

		const edges = lines
			.filter((each) => each.lane === index)
			.map(({ consumer, y, waiting, tooling }): GraphEdge => ({
				consumer,
				provider: repo,
				line: edgeLine(m.nodeX, x, y, own.y, m.curve),
				y,
				waiting,
				tooling,
			}));

		const segments: string[][] = STYLES.map(() => []);
		const heads: string[] = [];
		// Only a cycle has lines from above its own row.
		for (const direction of [1, -1] as const) {
			const ends = edges
				.filter((edge) => (edge.y - own.y) * direction > 0)
				.map((edge) => ({ rank: rank(edge), y: edge.y - direction * m.curve }));
			if (ends.length === 0) continue;
			const start = own.y + direction * m.laneOffset;
			let from = start;
			segments.forEach((part, partRank) => {
				const reached = ends.filter((end) => end.rank <= partRank);
				if (reached.length === 0) return;
				const to = Math.max(...reached.map((end) => end.y * direction)) * direction;
				if ((to - from) * direction <= 0) return;
				part.push(`M ${x} ${from} L ${x} ${to}`);
				from = to;
			});
			const behind = ends.some((end) => !STYLES[end.rank].waiting);
			heads.push(head(m, x, start, direction === 1 ? -1 : 1, behind ? 1 : 0.6));
		}
		const parts = STYLES.map((style, partRank) => ({
			...style,
			d: segments[partRank].join(' '),
		})).filter((part) => part.d !== '');

		return {
			repo,
			index,
			color: laneColor.get(repo) ?? null,
			label: laneLabel(repo),
			x,
			parts,
			heads: heads.join(' '),
			// Only what is behind and ships: under dots, a halo would fill the gaps between them.
			halo: [
				segments[0].join(' '),
				...edges.filter((edge) => rank(edge) === 0).map((edge) => edge.line),
			]
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
