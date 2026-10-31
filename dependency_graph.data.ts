/**
 * Feeds the interactive dependency graph.
 *
 * `public/dependency-graph.json` is the full record, evidence and all. The
 * component only needs to draw arrows, so this loader hands it a compact
 * payload: one entry per repository, one per dependent pair, and the
 * vocabulary of relation kinds taken straight from the generator — the page and
 * the diagram cannot disagree about what "download" means if neither of them
 * owns the word.
 *
 * The layout is worked out here too, so the page ships finished coordinates and
 * the browser never has to load the layout engine.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineLoader } from 'vitepress';
import { layoutGraph, type Box, type Point } from './scripts/dependency-graph/layout';
import { dependencyLinks, EDGE_KINDS, EDGE_KIND_META } from './scripts/dependency-graph/model';
import type {
	DependencyLink,
	EdgeKind,
	EdgeLineStyle,
	Graph,
	TagInfo,
} from './scripts/dependency-graph/model';

export interface GraphKind {
	id: EdgeKind;
	title: string;
	/** Ordering, so a pair drawn once is drawn as its most substantial link. */
	weight: number;
	/** How the arrow is drawn: width, dashes and arrowhead, but no colour. */
	line: EdgeLineStyle;
}

export interface GraphNode extends Box {
	name: string;
	/** Most characteristic first; the first entry decides the colour. */
	tags: string[];
	description: string | null;
}

export interface GraphLink extends DependencyLink {
	/** The routed line, from the source's border to the target's. */
	points: Point[];
}

export interface GraphData {
	tags: TagInfo[];
	kinds: GraphKind[];
	nodes: GraphNode[];
	links: GraphLink[];
}

declare const data: GraphData;
export { data };

export default defineLoader({
	watch: ['./public/dependency-graph.json'],
	async load(): Promise<GraphData> {
		const here = dirname(fileURLToPath(import.meta.url));
		const graph = JSON.parse(
			readFileSync(resolve(here, './public/dependency-graph.json'), 'utf8'),
		) as Graph;

		const { nodes, links } = await layoutGraph(
			graph.repos.map((repo) => ({
				name: repo.name,
				tags: repo.tags,
				description: repo.description,
			})),
			// Several files can prove the same dependency; the diagram draws it once.
			dependencyLinks(graph.edges),
		);

		return {
			tags: graph.tags,
			kinds: EDGE_KINDS.map((kind) => ({
				id: kind,
				title: EDGE_KIND_META[kind].title,
				weight: EDGE_KIND_META[kind].weight,
				line: EDGE_KIND_META[kind].line,
			})),
			nodes,
			links,
		};
	},
});
