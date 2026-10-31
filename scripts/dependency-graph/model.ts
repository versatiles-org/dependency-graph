/** Types shared by the dependency graph collector and renderer. */

export const EDGE_KINDS = [
	'npm',
	'cargo',
	'docker',
	'download',
	'workflow',
	'dispatch',
	'manual',
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * How an arrow is drawn in the interactive graph. Colour is deliberately not
 * part of it: the graph already spends colour on what a repository is, and a
 * second colour scale meaning something else would only compete with the first.
 * Width, dash pattern and the shape of the arrowhead carry the kind instead,
 * which also survives being printed or read by someone colour-blind.
 */
export interface EdgeLineStyle {
	width: number;
	/** SVG stroke-dasharray, or "none" for a solid line. */
	dash: string;
	head: 'filled' | 'hollow';
	/**
	 * How strongly the arrow is drawn. What a build genuinely needs is at full
	 * strength; relations that are real but incidental, such as one repository
	 * triggering another's CI, sit further back so they do not compete with it.
	 */
	opacity: number;
}

export interface EdgeKindMeta {
	/** Heading used for this kind's own section on the page. */
	title: string;
	/** One sentence explaining what such an arrow means. */
	summary: string;
	/** Ranking used when one pair of repositories is linked in several ways. */
	weight: number;
	line: EdgeLineStyle;
}

export const EDGE_KIND_META: Record<EdgeKind, EdgeKindMeta> = {
	npm: {
		title: 'npm packages',
		summary: 'The repository lists a `@versatiles/…` package among its npm dependencies.',
		weight: 7,
		line: { width: 1.5, dash: 'none', head: 'filled', opacity: 1 },
	},
	cargo: {
		title: 'Rust crates',
		summary: 'The repository depends on one of the project’s crates in `Cargo.toml`.',
		weight: 6,
		line: { width: 1.5, dash: '2 3', head: 'filled', opacity: 1 },
	},
	docker: {
		title: 'Docker images',
		summary: 'A `Dockerfile` builds on an image produced by another repository.',
		weight: 5,
		line: { width: 1.5, dash: '8 4', head: 'filled', opacity: 1 },
	},
	download: {
		title: 'Downloaded artifacts',
		summary:
			'Build scripts or runtime code fetch release assets or raw files from another repository.',
		weight: 4,
		line: { width: 1, dash: 'none', head: 'filled', opacity: 0.5 },
	},
	workflow: {
		title: 'CI workflows',
		summary:
			'A GitHub Actions workflow uses an action, reusable workflow or checkout of another repository.',
		weight: 3,
		line: { width: 1, dash: '8 4', head: 'filled', opacity: 0.5 },
	},
	dispatch: {
		title: 'Release triggers',
		summary:
			'A workflow starts a build in another repository. The table lists who starts whom; the arrow in the graph runs the other way, because the repository being rebuilt is the one that depends on the other.',
		weight: 2,
		line: { width: 1, dash: '4 3', head: 'filled', opacity: 0.5 },
	},
	manual: {
		title: 'Declared by hand',
		summary:
			'A dependency no parser can see — recorded in `scripts/dependency-graph.yaml` with a note.',
		weight: 1,
		line: { width: 1, dash: '1.5 3', head: 'hollow', opacity: 0.5 },
	},
};

export interface Edge {
	/**
	 * Repository the evidence was found in. That is the one depending on `to`,
	 * except for a `dispatch`: see {@link dependencyOf}.
	 */
	from: string;
	/** Repository the evidence names. */
	to: string;
	kind: EdgeKind;
	/** What exactly was found, e.g. an npm package name or an image tag. */
	detail: string;
	/** Path inside `from` that proves the edge; empty for manual edges. */
	path: string;
	/** 1-based line inside `path`, or 0 when unknown. */
	line: number;
}

/** One value from the tag vocabulary in the configuration. */
export interface TagInfo {
	id: string;
	title: string;
	/** Short line printed above the repositories carrying this tag. */
	summary: string;
	/** oklch hue angle the tag is drawn in; without one it is drawn grey. */
	hue?: number;
}

export interface RepoNode {
	name: string;
	/**
	 * What the repository is. Several are more than one thing, so this is a list
	 * rather than a single value; the first entry is the primary one and decides
	 * colour and placement where only one can be shown.
	 */
	tags: string[];
	description: string | null;
	language: string | null;
	fork: boolean;
	archived: boolean;
}

export interface Graph {
	org: string;
	tags: TagInfo[];
	repos: RepoNode[];
	edges: Edge[];
}

/**
 * Which repository depends on which.
 *
 * A dispatch is written down in the repository that fires it, but the dependency
 * runs the other way: when versatiles-rs starts the Homebrew build, Homebrew is
 * what follows versatiles-rs. Taken literally, these edges form cycles with the
 * downloads they accompany, and a layered layout can only draw a cycle by
 * pointing some of its arrows backward.
 */
export function dependencyOf(edge: Edge): { from: string; to: string } {
	return edge.kind === 'dispatch'
		? { from: edge.to, to: edge.from }
		: { from: edge.from, to: edge.to };
}

/** One dependency between two repositories, however many ways it is expressed. */
export interface DependencyLink {
	from: string;
	to: string;
	/** Every kind behind it, the most substantial first. */
	kinds: EdgeKind[];
}

/** Folds the evidence into one link per dependent pair, in first-seen order. */
export function dependencyLinks(edges: Edge[]): DependencyLink[] {
	const links = new Map<string, DependencyLink>();
	for (const edge of edges) {
		const { from, to } = dependencyOf(edge);
		const key = `${from} ${to}`;
		const link = links.get(key) ?? { from, to, kinds: [] };
		if (!link.kinds.includes(edge.kind)) link.kinds.push(edge.kind);
		links.set(key, link);
	}
	for (const link of links.values()) {
		link.kinds.sort((a, b) => EDGE_KIND_META[b].weight - EDGE_KIND_META[a].weight);
	}
	return [...links.values()];
}

/** Stable ordering, so regenerating without upstream changes produces no diff. */
export function sortEdges(edges: Edge[]): Edge[] {
	return [...edges].sort(
		(a, b) =>
			a.from.localeCompare(b.from) ||
			a.to.localeCompare(b.to) ||
			a.kind.localeCompare(b.kind) ||
			a.detail.localeCompare(b.detail) ||
			a.path.localeCompare(b.path) ||
			a.line - b.line,
	);
}
