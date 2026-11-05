<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
import { data, type GraphLink, type GraphNode } from '../../../dependency_graph.data';

/** The relation kinds the generator defines, without importing them twice. */
type EdgeKind = GraphLink['kinds'][number];

type Point = GraphLink['points'][number];

interface Link {
	source: GraphNode;
	target: GraphNode;
	/** Every kind behind this dependency, the most substantial first. */
	kinds: EdgeKind[];
	path: string;
}

/** Both come laid out: the build has already placed them. */
const nodes: GraphNode[] = data.nodes;
const byName = new Map(nodes.map((node) => [node.name, node]));

const links: Link[] = (() => {
	return data.links.flatMap((link: GraphLink) => {
		const source = byName.get(link.from);
		const target = byName.get(link.to);
		if (!source || !target) return [];
		return [{ source, target, kinds: link.kinds, path: pathOf(link.points) }];
	});
})();

const kindLine = new Map(data.kinds.map((kind) => [kind.id, kind.line]));

/**
 * How a link is drawn, as inline values rather than a class per kind. Opacity
 * goes in as a custom property instead of the property itself, so that the
 * dimming rules can replace it, and so that it lands on the element as a whole,
 * arrowhead included.
 */
function lineStyle(kind: EdgeKind): Record<string, string> {
	const line = kindLine.get(kind);
	return {
		'stroke-width': String(line?.width ?? 1.5),
		'stroke-dasharray': line?.dash ?? 'none',
		'--dg-link-opacity': String(line?.opacity ?? 1),
	};
}
const usedKinds = data.kinds.filter((kind) => links.some((link) => link.kinds.includes(kind.id)));
const kindTitles = new Map(data.kinds.map((kind) => [kind.id, kind.title]));
/**
 * The hue comes with the tag, so that what a colour means is decided where the
 * tags are. A tag without one is drawn grey: chroma is switched off rather than
 * a hue invented for it.
 */
function tagStyle(hue: number | undefined): Record<string, string> {
	if (hue === undefined) return { '--dg-fill-c': '0', '--dg-stroke-c': '0', '--dg-hue': '0' };
	return { '--dg-hue': String(hue) };
}
const tagStyles = new Map(data.tags.map((tag) => [tag.id, tagStyle(tag.hue)]));
const tagTitles = new Map(data.tags.map((tag) => [tag.id, tag.title]));

/** A repository can carry several tags; the first one decides its colour. */
function primaryTag(node: GraphNode): string {
	return node.tags[0] ?? '';
}

/* --------------------------------------------------------------------------
 * Filters
 * ----------------------------------------------------------------------- */

const kindOn = reactive<Record<string, boolean>>(
	Object.fromEntries(usedKinds.map((kind) => [kind.id, true])),
);
/** Dimmed until asked for, so the first view leads with the software itself. */
const TAGS_OFF_AT_START = new Set(['ecosystem', 'internal']);
const tagOn = reactive<Record<string, boolean>>(
	Object.fromEntries(data.tags.map((tag) => [tag.id, !TAGS_OFF_AT_START.has(tag.id)])),
);
const showUnconnected = ref(true);

/** A link is drawn as the most substantial of its kinds still switched on. */
function drawnKind(link: Link): EdgeKind {
	return link.kinds.find((kind) => kindOn[kind]) ?? link.kinds[0];
}

/**
 * What the filters leave at full strength. Everything else is only dimmed: the
 * layout always holds every repository and dependency, so a repository stays
 * where the reader last saw it whichever filters are on.
 */
const visible = computed(() => {
	const shown = new Map<string, boolean>();
	// More than one tag can apply, so a repository stays as long as any of its
	// tags is switched on.
	for (const node of nodes) {
		shown.set(
			node.name,
			node.tags.some((tag) => tagOn[tag]),
		);
	}

	const activeLinks = links.filter(
		(link) =>
			link.kinds.some((kind) => kindOn[kind]) &&
			shown.get(link.source.name) &&
			shown.get(link.target.name),
	);

	if (!showUnconnected.value) {
		const touched = new Set(activeLinks.flatMap((link) => [link.source.name, link.target.name]));
		for (const node of nodes) if (!touched.has(node.name)) shown.set(node.name, false);
	}

	return { shown, links: activeLinks, nodes: nodes.filter((node) => shown.get(node.name)) };
});

const root = ref<HTMLElement>();
const figure = ref<HTMLElement>();
const svg = ref<SVGSVGElement>();
const expanded = ref(false);
const size = ref({ width: 960, height: 560 });

/**
 * A phone, upright or on its side. There the graph on the page is only a preview
 * that opens full screen: fitted into the column it is too small to read or to
 * tap, and a canvas taking every swipe would trap the reader on the page. Wide
 * until mounted, as the server cannot know the screen.
 */
const NARROW_QUERY = '(max-width: 720px), (max-height: 500px)';
const narrow = ref(false);
let narrowQuery: MediaQueryList | undefined;
function onNarrowChange(): void {
	narrow.value = narrowQuery?.matches ?? false;
}
/** On a phone the filters wait behind one button, so that the graph keeps the screen. */
const filtersOpen = ref(false);

/** The layout's own extent, which every fit starts from. */
const bounds = (() => {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of nodes) {
		minX = Math.min(minX, node.x - node.w / 2);
		maxX = Math.max(maxX, node.x + node.w / 2);
		minY = Math.min(minY, node.y - node.h / 2);
		maxY = Math.max(maxY, node.y + node.h / 2);
	}
	return { minX, minY, maxX, maxY };
})();

const PADDING = 24;
/** Far enough out that the whole graph fits on a phone held sideways. */
const MIN_SCALE = 0.1;

// Fitted from the start, so the server-rendered page already shows the graph.
const transform = shallowRef<ZoomTransform>(fittedTransform());
/** Under the mouse. */
const hovered = ref<string | null>(null);
/** Clicked or tapped, which is the only way to isolate a repository on a touch screen. */
const selected = ref<string | null>(null);
const selectedNode = computed(() =>
	selected.value === null ? null : (byName.get(selected.value) ?? null),
);

/** The preview on a phone is as high as the graph needs at the column's width. */
const previewHeight = computed(() => {
	const ratio = (bounds.maxY - bounds.minY) / Math.max(bounds.maxX - bounds.minX, 1);
	return Math.round(ratio * (size.value.width - PADDING * 2) + PADDING * 2);
});

/* --------------------------------------------------------------------------
 * Camera
 * ----------------------------------------------------------------------- */

/**
 * The layout has its own coordinates, so the camera fits itself around the whole
 * graph. Panning or zooming takes it over, until the reader asks for it back.
 */
let userMoved = false;

function fittedTransform(): ZoomTransform {
	const { minX, minY, maxX, maxY } = bounds;
	if (!Number.isFinite(minX)) return zoomIdentity;

	const { width, height } = size.value;
	const fitX = (width - PADDING * 2) / Math.max(maxX - minX, 1);
	const fitY = (height - PADDING * 2) / Math.max(maxY - minY, 1);
	// Full screen on a phone, the graph fills the screen and pans the other way:
	// fitted whole, it would be a strip too small to read or to tap.
	const cover = narrow.value && expanded.value;
	const scale = Math.min(
		1.1,
		Math.max(MIN_SCALE, cover ? Math.max(fitX, fitY) : Math.min(fitX, fitY)),
	);
	return zoomIdentity
		.translate(width / 2 - ((minX + maxX) / 2) * scale, height / 2 - ((minY + maxY) / 2) * scale)
		.scale(scale);
}

function fitView(): void {
	const element = svg.value;
	if (!element) return;

	const next = fittedTransform();
	transform.value = next;
	// Keep d3-zoom's own state in step, or the next pan would jump.
	zoomBehaviour.transform(select(element), next);
}

function resetView(): void {
	userMoved = false;
	fitView();
}

const zoomBehaviour = zoom<SVGSVGElement, unknown>()
	.scaleExtent([MIN_SCALE, 3])
	.on('zoom', (event: { transform: ZoomTransform; sourceEvent: unknown }) => {
		transform.value = event.transform;
		// sourceEvent is null when fitView moved the camera itself.
		if (event.sourceEvent) userMoved = true;
	});

/* --------------------------------------------------------------------------
 * Full screen
 * ----------------------------------------------------------------------- */

/**
 * The Fullscreen API where it exists, and a fixed overlay where it does not —
 * iOS Safari allows it for video only. Both paths set the same class, so the
 * styling has one shape to worry about, and the resize observer re-fits the
 * camera either way.
 */
async function toggleExpanded(): Promise<void> {
	const element = figure.value;
	if (!element) return;

	if (expanded.value) {
		if (document.fullscreenElement) {
			try {
				await document.exitFullscreen();
			} catch {
				// Leaving the overlay behind would trap the reader; the class goes either way.
			}
		}
		setExpanded(false);
		return;
	}

	setExpanded(true);
	try {
		await element.requestFullscreen();
	} catch {
		// The overlay is the fallback, and it is already in place.
	}
}

/**
 * On a phone the camera starts over on the way in and on the way out: the full
 * screen fits the graph differently, and the preview must show all of it again.
 */
function setExpanded(value: boolean): void {
	if (expanded.value === value) return;
	expanded.value = value;
	if (!narrow.value) return;
	filtersOpen.value = false;
	// The preview has no room to say why most of it would be dimmed.
	if (!value) selected.value = null;
	userMoved = false;
	// After the canvas has its new size; the resize observer only catches a change of it.
	void nextTick(fitView);
}

function onFullscreenChange(): void {
	if (!document.fullscreenElement) setExpanded(false);
}

/** Escape leaves the overlay; real full screen handles that key itself. */
function onKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape' && expanded.value && !document.fullscreenElement) {
		setExpanded(false);
	}
}

/* --------------------------------------------------------------------------
 * Rendering
 * ----------------------------------------------------------------------- */

const view = computed(() => {
	const active = hovered.value ?? selected.value;
	const shownNodes = visible.value.shown;
	const activeLinks = new Set(visible.value.links);

	const neighbours = new Set<string>();
	if (active !== null) {
		neighbours.add(active);
		for (const link of visible.value.links) {
			if (link.source.name === active) neighbours.add(link.target.name);
			if (link.target.name === active) neighbours.add(link.source.name);
		}
	}

	return {
		nodes: nodes.map((node) => ({
			node,
			filtered: !shownNodes.get(node.name),
			dimmed: active !== null && !neighbours.has(node.name),
		})),
		links: links.map((link) => ({
			link,
			kind: drawnKind(link),
			filtered: !activeLinks.has(link),
			dimmed: active !== null && link.source.name !== active && link.target.name !== active,
		})),
	};
});

/**
 * The routed polyline, with its corners rounded off.
 *
 * The line stays on the waypoints the layout chose — they are where they are to keep
 * the edge clear of the label boxes — and only the corner itself is replaced by
 * an arc. A curve fitted through the waypoints instead would drift off the
 * route between them, which is the routing spent on nothing.
 *
 * The radius is clamped to half of each adjoining segment, so neighbouring
 * corners can never eat into one another however tightly they are packed.
 */
function pathOf(points: Point[]): string {
	if (points.length < 2) return '';
	const at = (point: Point): string => `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
	if (points.length === 2) return `M${at(points[0])} L${at(points[1])}`;

	/** How far back from a corner the arc starts, in layout units. */
	const radius = 16;
	const towards = (from: Point, to: Point, distance: number): Point => {
		const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
		const step = distance / length;
		return { x: from.x + (to.x - from.x) * step, y: from.y + (to.y - from.y) * step };
	};

	let path = `M${at(points[0])}`;
	for (let i = 1; i < points.length - 1; i++) {
		const corner = points[i];
		const before = points[i - 1];
		const after = points[i + 1];
		const reach = Math.min(
			radius,
			Math.hypot(corner.x - before.x, corner.y - before.y) / 2,
			Math.hypot(after.x - corner.x, after.y - corner.y) / 2,
		);
		if (reach < 0.5) {
			path += ` L${at(corner)}`;
			continue;
		}
		path += ` L${at(towards(corner, before, reach))} Q${at(corner)} ${at(towards(corner, after, reach))}`;
	}
	return `${path} L${at(points[points.length - 1])}`;
}

/** Where the repository sits in the project, and what it is. */
function about(node: GraphNode): string {
	const tags = node.tags.map((tag) => tagTitles.get(tag) ?? tag).join(', ');
	return `${tags}${node.description ? `. ${node.description}` : ''}`;
}

/** Native tooltip, which only a mouse can bring up. */
function describe(node: GraphNode): string {
	return `${node.name} — ${about(node)}`;
}

/** A click or tap keeps a repository isolated, and a second one lets it go. */
function toggleSelected(name: string): void {
	selected.value = selected.value === name ? null : name;
}

/** A finger also enters and leaves, but only a mouse can point without choosing. */
function onPointerEnter(event: PointerEvent, name: string): void {
	if (event.pointerType === 'mouse') hovered.value = name;
}

/**
 * Native tooltip: every way a dependency is expressed. One line stands for all
 * of them, and an arrow alone cannot say that the target also starts a build.
 */
function describeLink(link: Link): string {
	const kinds = link.kinds.map((kind) => kindTitles.get(kind) ?? kind).join(', ');
	const dispatch = link.kinds.includes('dispatch')
		? `. ${link.target.name} starts a build of ${link.source.name}`
		: '';
	return `${link.source.name} depends on ${link.target.name} — ${kinds}${dispatch}`;
}

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

let observer: ResizeObserver | undefined;

onMounted(() => {
	const element = root.value;
	if (!element) return;

	// The size is the canvas's own, never a floor: a viewBox taller than the canvas
	// would shrink the whole drawing a second time.
	observer = new ResizeObserver(([entry]) => {
		const { width, height } = entry.contentRect;
		// Hidden, it has no size to fit.
		if (width === 0 || height === 0) return;
		if (width === size.value.width && height === size.value.height) return;
		size.value = { width, height };
		// The layout has its own coordinates, so only the camera has to react.
		if (!userMoved) fitView();
	});
	observer.observe(element);
	document.addEventListener('fullscreenchange', onFullscreenChange);
	document.addEventListener('keydown', onKeydown);

	narrowQuery = window.matchMedia(NARROW_QUERY);
	onNarrowChange();
	narrowQuery.addEventListener('change', onNarrowChange);

	const box = element.getBoundingClientRect();
	if (box.width > 0 && box.height > 0) size.value = { width: box.width, height: box.height };

	if (svg.value) select(svg.value).call(zoomBehaviour);
	fitView();
});

onBeforeUnmount(() => {
	observer?.disconnect();
	document.removeEventListener('fullscreenchange', onFullscreenChange);
	document.removeEventListener('keydown', onKeydown);
	narrowQuery?.removeEventListener('change', onNarrowChange);
});
</script>

<template>
	<figure ref="figure" class="dependency-graph" :class="{ expanded, narrow }">
		<div v-if="narrow && expanded" class="toolbar">
			<button
				type="button"
				class="chip plain"
				:aria-expanded="filtersOpen"
				@click="filtersOpen = !filtersOpen"
			>
				{{ filtersOpen ? 'Hide filters' : 'Filters' }}
			</button>
			<div class="group end">
				<button type="button" class="chip plain" @click="resetView">Reset view</button>
				<button type="button" class="chip plain" @click="toggleExpanded">Close</button>
			</div>
		</div>

		<div v-if="!narrow || (expanded && filtersOpen)" class="controls">
			<div class="group" role="group" aria-label="Kinds of dependency">
				<span class="group-label">Dependencies</span>
				<button
					v-for="kind in usedKinds"
					:key="kind.id"
					type="button"
					class="chip"
					:class="{ off: !kindOn[kind.id] }"
					:aria-pressed="kindOn[kind.id]"
					@click="kindOn[kind.id] = !kindOn[kind.id]"
				>
					<svg viewBox="0 0 30 10" aria-hidden="true">
						<path
							d="M1,5 L21,5"
							:style="lineStyle(kind.id)"
							:marker-end="`url(#dg-arrow-${kind.id})`"
						/>
					</svg>
					{{ kind.title }}
				</button>
			</div>

			<div class="group" role="group" aria-label="Kinds of repository">
				<span class="group-label">Repositories</span>
				<button
					v-for="tag in data.tags"
					:key="tag.id"
					type="button"
					class="chip tag"
					:class="{ off: !tagOn[tag.id] }"
					:style="tagStyles.get(tag.id)"
					:aria-pressed="tagOn[tag.id]"
					:title="tag.summary"
					@click="tagOn[tag.id] = !tagOn[tag.id]"
				>
					<span class="box" aria-hidden="true" />
					{{ tag.title }}
				</button>
				<button
					type="button"
					class="chip plain"
					:class="{ off: !showUnconnected }"
					:aria-pressed="showUnconnected"
					@click="showUnconnected = !showUnconnected"
				>
					show unconnected
				</button>
			</div>

			<div v-if="!narrow" class="group end">
				<button type="button" class="chip plain" @click="resetView">Reset view</button>
				<button
					type="button"
					class="chip plain"
					:aria-pressed="expanded"
					@click="toggleExpanded"
				>
					{{ expanded ? 'Exit full screen' : 'Full screen' }}
				</button>
			</div>
		</div>

		<div
			ref="root"
			class="canvas"
			:style="narrow && !expanded ? { height: `${previewHeight}px` } : undefined"
		>
			<svg
				ref="svg"
				class="stage"
				:viewBox="`0 0 ${size.width} ${size.height}`"
				:aria-label="`Dependencies between ${nodes.length} repositories`"
				@click="selected = null"
			>
				<defs>
					<marker
						v-for="kind in usedKinds"
						:id="`dg-arrow-${kind.id}`"
						:key="kind.id"
						class="arrow"
						:class="`head-${kind.line.head}`"
						viewBox="0 0 12 12"
						:refX="kind.line.head === 'hollow' ? 10.5 : 10"
						refY="6"
						markerWidth="8"
						markerHeight="8"
						markerUnits="userSpaceOnUse"
						orient="auto-start-reverse"
					>
						<path d="M1,1.5 L11,6 L1,10.5 z" />
					</marker>
				</defs>

				<g :transform="`translate(${transform.x},${transform.y}) scale(${transform.k})`">
					<path
						v-for="(edge, index) in view.links"
						:key="index"
						class="link"
						:class="{ dimmed: edge.dimmed, filtered: edge.filtered }"
						:style="lineStyle(edge.kind)"
						:d="edge.link.path"
						:marker-end="`url(#dg-arrow-${edge.kind})`"
					>
						<title>{{ describeLink(edge.link) }}</title>
					</path>

					<g
						v-for="entry in view.nodes"
						:key="entry.node.name"
						class="node"
						:class="{ dimmed: entry.dimmed, filtered: entry.filtered }"
						:style="tagStyles.get(primaryTag(entry.node))"
						:transform="`translate(${entry.node.x},${entry.node.y})`"
						@pointerenter="onPointerEnter($event, entry.node.name)"
						@pointerleave="hovered = null"
						@click.stop="toggleSelected(entry.node.name)"
					>
						<title>{{ describe(entry.node) }}</title>
						<rect
							:x="-entry.node.w / 2"
							:y="-entry.node.h / 2"
							:width="entry.node.w"
							:height="entry.node.h"
							rx="5"
						/>
						<text class="label" dy="0.35em">{{ entry.node.name }}</text>
					</g>
				</g>
			</svg>

			<!-- Covering the canvas, so that a swipe across the preview scrolls the page. -->
			<button v-if="narrow && !expanded" type="button" class="explore" @click="toggleExpanded">
				<span>Tap to explore</span>
			</button>

			<p v-else-if="selectedNode" class="selection" role="status">
				<strong>{{ selectedNode.name }}</strong> — {{ about(selectedNode) }}
				<button
					type="button"
					class="close"
					aria-label="Stop isolating this repository"
					@click="selected = null"
				>
					×
				</button>
			</p>
		</div>

		<figcaption v-if="!(narrow && expanded)" class="status">
			Highlighting {{ visible.nodes.length }} of {{ nodes.length }} repositories and
			{{ visible.links.length }} of {{ links.length }} dependencies. Arrows run left to right,
			from a repository to what it depends on.
			<template v-if="narrow">
				Tap the graph to open it full screen, then pinch to zoom, drag to pan and tap a
				repository to isolate it.
			</template>
			<template v-else>
				Scroll to zoom, drag the background to pan, point at a repository to isolate it, and
				click it to keep it isolated.
			</template>
		</figcaption>
	</figure>
</template>

<style scoped>
/*
 * Every colour is oklch with a per-tag hue passed in as --dg-hue, so the whole
 * palette moves in one step between light and dark mode.
 */
.dependency-graph {
	--dg-fill-l: 0.95;
	--dg-fill-c: 0.045;
	--dg-stroke-l: 0.62;
	--dg-stroke-c: 0.11;
	/* Edges are deliberately grey: colour belongs to the tags. */
	--dg-edge: oklch(0.52 0 0);

	margin: 24px 0;

	/*
	 * A dependency graph in a 688px prose column is unreadable, so the figure
	 * steps outside it: centred, never wider than the viewport minus a gutter.
	 */
	width: min(100vw - 48px, 1000px);
	margin-inline: calc(50% - min(50vw - 24px, 500px));
}

/*
 * Written as a plain descendant selector: scoped CSS keeps the class on the
 * last element of the selector, so `.dark` stays a real ancestor. Wrapping it
 * in :global() instead drops the descendant part and the override lands on
 * <html>, where the element's own values beat it.
 */
.dark .dependency-graph {
	--dg-fill-l: 0.27;
	--dg-fill-c: 0.04;
	--dg-stroke-l: 0.68;
	--dg-stroke-c: 0.1;
	--dg-edge: oklch(0.72 0 0);
}

/* Controls --------------------------------------------------------------- */

.controls {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 16px;
	margin-bottom: 10px;
}

.group {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
}

.group.end {
	margin-left: auto;
}

.group-label {
	color: var(--vp-c-text-3);
	font-size: 13px;
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 3px 10px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 999px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font-size: 13px;
	line-height: 1.5;
	transition:
		opacity 0.15s ease,
		border-color 0.15s ease;
}

.chip:hover {
	border-color: var(--vp-c-brand-1);
}

.chip.off {
	opacity: 0.45;
	color: var(--vp-c-text-3);
}

.chip svg {
	width: 30px;
	height: 10px;
	overflow: visible;
}

.chip path {
	fill: none;
	stroke: var(--dg-edge);
	opacity: var(--dg-link-opacity, 1);
}

.chip.tag .box {
	width: 20px;
	height: 12px;
	border-radius: 3px;
	border: 1.2px solid oklch(var(--dg-stroke-l) var(--dg-stroke-c) var(--dg-hue));
	background: oklch(var(--dg-fill-l) var(--dg-fill-c) var(--dg-hue));
}

/* Full screen ------------------------------------------------------------ */

.dependency-graph.expanded {
	position: fixed;
	inset: 0;
	z-index: 60;
	display: flex;
	flex-direction: column;
	width: auto;
	margin: 0;
	padding: 12px 16px 8px;
	background: var(--vp-c-bg);
}

.dependency-graph.expanded .canvas {
	flex: 1;
	height: auto;
}

/* Phones ----------------------------------------------------------------- */

.toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}

/* Big enough for a finger. */
.narrow .chip {
	min-height: 36px;
	padding: 4px 12px;
}

/* A phone held sideways still sees the page around the preview. */
.narrow .canvas {
	max-height: 60vh;
}

.dependency-graph.narrow.expanded .canvas {
	max-height: none;
}

/*
 * Over the graph rather than above it: pushing the canvas down would shrink it,
 * and the camera would fit the graph again each time the filters open.
 */
.dependency-graph.narrow.expanded .controls {
	position: absolute;
	top: calc(max(8px, env(safe-area-inset-top)) + 44px);
	inset-inline: max(12px, env(safe-area-inset-left)) max(12px, env(safe-area-inset-right));
	z-index: 1;
	max-height: 70%;
	overflow-y: auto;
	padding: 12px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background: var(--vp-c-bg);
	box-shadow: var(--vp-shadow-3);
}

/* Clear of a notch or a rounded corner. */
.dependency-graph.narrow.expanded {
	padding: max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
		max(8px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
}

.explore {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: flex-end;
	justify-content: center;
	padding-bottom: 12px;
	cursor: pointer;

	span {
		padding: 6px 14px;
		border: 1px solid var(--vp-c-divider);
		border-radius: 999px;
		background: var(--vp-c-bg);
		color: var(--vp-c-text-1);
		font-size: 13px;
		box-shadow: var(--vp-shadow-2);
	}
}

.selection {
	position: absolute;
	inset: auto 8px 8px;
	margin: 0;
	padding: 8px 40px 8px 12px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-2);
	font-size: 13px;
	line-height: 1.4;
	box-shadow: var(--vp-shadow-2);

	strong {
		color: var(--vp-c-text-1);
	}

	.close {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 36px;
		height: 36px;
		color: var(--vp-c-text-2);
		font-size: 20px;
		line-height: 1;
	}
}

/* Canvas ----------------------------------------------------------------- */

.canvas {
	position: relative;
	height: clamp(420px, 62vh, 720px);
	border: 1px solid var(--vp-c-divider);
	border-radius: 8px;
	background: var(--vp-c-bg-alt);
	overflow: hidden;
}

.stage {
	display: block;
	width: 100%;
	height: 100%;
	touch-action: none;
	cursor: grab;
}

.stage:active {
	cursor: grabbing;
}

/* Nodes ------------------------------------------------------------------ */

.node {
	transition: opacity 0.25s ease;
}

.node rect {
	fill: oklch(var(--dg-fill-l) var(--dg-fill-c) var(--dg-hue));
	stroke: oklch(var(--dg-stroke-l) var(--dg-stroke-c) var(--dg-hue));
	stroke-width: 1.2;
}

.node .label {
	fill: var(--vp-c-text-1);
	font-size: 12px;
	text-anchor: middle;
	pointer-events: none;
	user-select: none;
}

/* One floor for everything set back, by a filter or by hovering a repository. */
.node.filtered,
.link.filtered,
.node.dimmed,
.link.dimmed {
	opacity: 0.1;
}

.node.filtered,
.link.filtered {
	pointer-events: none;
}

/* Links ------------------------------------------------------------------ */

/*
 * Width, dashes and arrowhead come from the kind vocabulary as inline
 * attributes, so there is no rule per kind here — only the ink they share.
 */
.link {
	fill: none;
	stroke: var(--dg-edge);
	stroke-linecap: round;
	opacity: var(--dg-link-opacity, 1);
	transition: opacity 0.25s ease;
}

.arrow path {
	stroke: var(--dg-edge);
}

.arrow.head-filled path {
	fill: var(--dg-edge);
	stroke: none;
}

/* Hollow heads are punched out of the canvas, so the line cannot show through. */
.arrow.head-hollow path {
	fill: var(--vp-c-bg-alt);
	stroke-width: 1.6;
}

/* Caption ---------------------------------------------------------------- */

.status {
	margin-top: 8px;
	color: var(--vp-c-text-3);
	font-size: 13px;
	text-align: left;
}

@media (prefers-reduced-motion: reduce) {
	.node,
	.link,
	.chip {
		transition: none;
	}
}
</style>
