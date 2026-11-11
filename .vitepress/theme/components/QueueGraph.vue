<script setup lang="ts">
/**
 * The queue of repositories to update, with a line from each to the packages it
 * is behind on. The layout comes from `queue-graph.ts`; this draws it, and keeps
 * which row is highlighted.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
	githubUrl,
	STATUS,
	type QueueEntry,
	type Wait,
} from '../../../scripts/dependency-graph/status-view';
import {
	buildQueueGraph,
	NARROW,
	WIDE,
	type GraphEdge,
	type GraphRow,
} from '../../../scripts/dependency-graph/queue-graph';

const props = defineProps<{
	queue: QueueEntry[];
	/** Repository to the packages it publishes. */
	publishes: Record<string, string[]>;
	/** What `waitingOn` returns for the whole queue, so that a filter cannot hide a wait. */
	waiting: Record<string, Wait[]>;
	org: string;
}>();

const repoUrl = (repo: string): string => githubUrl(props.org, repo);
const fileUrl = (repo: string, path: string): string => githubUrl(props.org, repo, path);

/**
 * On a phone the graph stacks its text right of the lanes, so that nothing scrolls
 * sideways. Wide until mounted: the server cannot know the screen.
 */
const narrow = ref(false);
let narrowQuery: MediaQueryList | undefined;
const onNarrowChange = (): void => {
	narrow.value = narrowQuery?.matches ?? false;
};
onMounted(() => {
	narrowQuery = window.matchMedia('(max-width: 720px)');
	onNarrowChange();
	narrowQuery.addEventListener('change', onNarrowChange);
});
onBeforeUnmount(() => narrowQuery?.removeEventListener('change', onNarrowChange));

const metrics = computed(() => (narrow.value ? NARROW : WIDE));
const graph = computed(() =>
	buildQueueGraph(props.queue, props.publishes, props.waiting, metrics.value),
);

/* Where the columns start, around a graph as wide as it has lanes. */
const graphLeft = computed(() => (narrow.value ? 0 : 296));
const behindLeft = computed(() => graphLeft.value + graph.value.width);
const updateLeft = computed(() => behindLeft.value + 88);
const graphMinWidth = computed(() => (narrow.value ? 0 : updateLeft.value + 240));
/** Stacked, all text starts right of the lanes. */
const textLeft = computed(() => `${graph.value.width}px`);

/** Pointing at a row highlights its lines, and clicking keeps them highlighted. */
const pinned = ref<string | null>(null);
const hovered = ref<string | null>(null);
const active = computed(() => {
	const repo = pinned.value ?? hovered.value;
	// The row may have been filtered away since.
	return graph.value.rows.some((row) => row.repo === repo) ? repo : null;
});
const edgeLit = (edge: GraphEdge): boolean =>
	active.value === null || edge.consumer === active.value || edge.provider === active.value;
const laneLit = (lane: { repo: string; edges: GraphEdge[] }): boolean =>
	active.value === lane.repo || lane.edges.some(edgeLit);
const rowLit = (repo: string): boolean =>
	active.value === null ||
	graph.value.lanes.some((lane) =>
		lane.edges.some(
			(edge) => edgeLit(edge) && (edge.consumer === repo || edge.provider === repo),
		),
	);
const banded = (row: GraphRow, index: number): boolean => row.position !== null && index % 2 === 0;
/** What a label sits on, so that it can hide the lines passing behind it. */
const rowBackground = (row: GraphRow, index: number): string =>
	active.value === row.repo
		? 'var(--vp-c-brand-soft)'
		: banded(row, index)
			? 'var(--vp-c-bg-soft)'
			: 'var(--vp-c-bg)';
const togglePin = (repo: string): void => {
	pinned.value = pinned.value === repo ? null : repo;
};

/** The first package ends up on top: later ones are painted first, each halo under its lines. */
const paintOrder = computed(() => [...graph.value.lanes].reverse());
/** A lane with only waiting lines is grey. */
const laneColored = (index: number): boolean => graph.value.lanes[index]?.color != null;
const laneColor = (index: number): string => {
	const color = graph.value.lanes[index]?.color ?? null;
	return color === null ? 'var(--vp-c-text-2)' : `var(--st-lane-${color % 6})`;
};
</script>

<template>
	<ul class="graph-key">
		<li>Each colour is one package. A line curves up into what the repository uses.</li>
		<li>
			<svg width="32" height="8" viewBox="0 0 32 8" aria-hidden="true">
				<path d="M 3 4 L 30 4" class="graph-key-tooling" />
			</svg>
			Only development tooling, which is not in the released code
		</li>
		<li>
			<svg width="32" height="8" viewBox="0 0 32 8" aria-hidden="true">
				<path d="M 2 4 L 30 4" class="graph-key-waiting" />
			</svg>
			Not behind yet, but will be once that one is released
		</li>
		<li>
			<span class="mark is-range" aria-hidden="true">{{ STATUS.range.mark }}</span>
			The version range has to change
		</li>
		<li>
			<span class="mark is-stale-lock" aria-hidden="true">{{ STATUS['stale-lock'].mark }}</span>
			A lockfile update is enough
		</li>
		<li>Point at a row to highlight its lines, or click or tap it to keep them highlighted.</li>
	</ul>
	<div class="scroll" tabindex="0">
		<div
			class="graph"
			:class="{ narrow }"
			:style="{
				height: `${graph.height}px`,
				minWidth: `${graphMinWidth}px`,
				'--text-left': textLeft,
			}"
		>
			<div v-if="!narrow" class="graph-head">
				<span :style="{ left: '36px' }">Repository and package</span>
				<span :style="{ left: `${graphLeft}px` }">Depends on</span>
				<span :style="{ left: `${behindLeft}px` }">Behind</span>
				<span :style="{ left: `${updateLeft}px` }">Update</span>
			</div>
			<h2
				v-if="graph.hasReleases"
				class="graph-group"
				:style="{ top: `${metrics.firstLabelTop}px` }"
			>
				Packages with a newer release
			</h2>
			<h2 class="graph-group" :style="{ top: `${graph.queueLabelTop}px` }">
				Repositories to update, in order
			</h2>

			<div
				v-for="(row, index) in graph.rows"
				:key="row.repo"
				class="graph-row"
				:class="{
					'in-queue': row.position !== null,
					banded: banded(row, index),
					active: active === row.repo,
					faint: !rowLit(row.repo),
				}"
				:style="{ top: `${row.top}px`, height: `${row.height}px` }"
				@mouseenter="hovered = row.repo"
				@mouseleave="hovered = null"
			>
				<button
					type="button"
					class="graph-row-select"
					:aria-pressed="pinned === row.repo"
					:aria-label="`Highlight the lines of ${row.repo}`"
					@click="togglePin(row.repo)"
					@focus="hovered = row.repo"
					@blur="hovered = null"
				/>
				<span v-if="!narrow" class="row-position">{{ row.position }}</span>
				<span class="row-name">
					<span class="row-title">
						<span v-if="narrow && row.position !== null" class="row-number">{{
							row.position
						}}</span>
						<a
							:href="repoUrl(row.repo)"
							:style="
								row.lane !== null && laneColored(row.lane)
									? { color: laneColor(row.lane) }
									: undefined
							"
							>{{ row.repo }}</a
						>
					</span>
					<span class="row-packages" :title="row.packages">{{ row.packages }}</span>
				</span>
				<span
					v-if="row.latest"
					class="row-summary"
					:style="narrow ? { top: `${metrics.detailsTop}px` } : { left: `${behindLeft}px` }"
				>
					Latest <span class="mono">{{ row.latest }}</span
					>,<br v-if="narrow" />
					{{ row.behindCount }}
					{{ row.behindCount === 1 ? 'repository' : 'repositories' }} behind
				</span>
				<template
					v-for="detail in row.details"
					:key="`${detail.name} ${detail.path} ${detail.section}`"
				>
					<!-- Stacked: what is behind and in which package, then the versions. -->
					<template v-if="narrow">
						<span
							class="row-behind"
							:class="[`is-${detail.status}`, `behind-${detail.behind}`]"
							:style="{ top: `${detail.y}px` }"
							:title="STATUS[detail.status].label"
						>
							<span class="mark" aria-hidden="true">{{ STATUS[detail.status].mark }}</span>
							{{ detail.behind }}
							<a
								:href="fileUrl(detail.consumer, detail.path)"
								:title="`${detail.name} in ${detail.path}`"
								:style="{ color: laneColor(detail.lane) }"
								>{{ graph.lanes[detail.lane].label }}</a
							>
						</span>
						<span class="row-update" :style="{ top: `${detail.y + 18}px` }">
							<span class="mono"
								>{{ detail.installed ?? '—' }} → {{ detail.latest ?? '?' }}</span
							>
							<span v-if="detail.tooling" class="tooling">tooling</span>
						</span>
					</template>
					<template v-else>
						<span
							class="row-behind"
							:class="[`is-${detail.status}`, `behind-${detail.behind}`]"
							:style="{ left: `${behindLeft}px`, top: `${detail.y}px` }"
							:title="STATUS[detail.status].label"
						>
							<span class="mark" aria-hidden="true">{{ STATUS[detail.status].mark }}</span>
							{{ detail.behind }}
						</span>
						<span
							class="row-update"
							:style="{ left: `${updateLeft}px`, top: `${detail.y}px` }"
						>
							<a
								:href="fileUrl(detail.consumer, detail.path)"
								:title="`${detail.name} in ${detail.path}`"
								:style="{ color: laneColor(detail.lane) }"
								>{{ graph.lanes[detail.lane].label }}</a
							>
							<span class="mono"
								>{{ detail.installed ?? '—' }} → {{ detail.latest ?? '?' }}</span
							>
							<span v-if="detail.tooling" class="tooling">tooling</span>
						</span>
					</template>
				</template>
				<span
					v-for="wait in row.waits"
					:key="`waits ${wait.lane}`"
					class="row-update row-wait"
					:style="
						narrow ? { top: `${wait.y}px` } : { left: `${updateLeft}px`, top: `${wait.y}px` }
					"
				>
					after {{ graph.lanes[wait.lane].label }} is released
				</span>
			</div>

			<svg
				class="graph-lines"
				:width="graph.width"
				:height="graph.height"
				:viewBox="`0 0 ${graph.width} ${graph.height}`"
				:style="{ left: `${graphLeft}px` }"
				aria-hidden="true"
			>
				<g
					v-for="lane in paintOrder"
					:key="lane.repo"
					:style="{ '--lane': laneColor(lane.index) }"
					:class="{ faint: !laneLit(lane) }"
				>
					<path v-if="lane.halo" class="lane-halo" :d="lane.halo" />
					<path
						v-for="part in lane.parts"
						:key="`${part.waiting} ${part.tooling}`"
						class="lane-line"
						:class="{ tooling: part.tooling, waiting: part.waiting }"
						:d="part.d"
					/>
					<path class="lane-head" :d="lane.heads" />
					<path
						v-for="edge in lane.edges"
						:key="edge.consumer"
						class="lane-line"
						:class="{
							tooling: edge.tooling,
							waiting: edge.waiting,
							faint: !edgeLit(edge),
						}"
						:d="edge.line"
					/>
					<circle
						v-for="edge in lane.edges"
						:key="`dot ${edge.consumer}`"
						class="graph-dot"
						:class="{ faint: !edgeLit(edge) }"
						:cx="metrics.nodeX"
						:cy="edge.y"
						:r="metrics.dotRadius"
					/>
				</g>
				<g
					v-for="(row, index) in graph.rows"
					:key="row.repo"
					:class="{ faint: !rowLit(row.repo) }"
					:style="{ '--row-bg': rowBackground(row, index) }"
				>
					<circle
						v-if="row.lane !== null"
						class="graph-node"
						:cx="graph.lanes[row.lane].x"
						:cy="row.y"
						:r="metrics.nodeRadius"
						:style="{ fill: laneColor(row.lane) }"
					/>
					<!-- Stacked, the name beside the node is in the lane's colour instead. -->
					<text
						v-if="row.lane !== null && !narrow"
						class="graph-label"
						:x="graph.lanes[row.lane].x + 12"
						:y="row.y + 4"
						:style="{ fill: laneColor(row.lane) }"
					>
						{{ graph.lanes[row.lane].label }}
					</text>
				</g>
			</svg>
		</div>
	</div>
</template>

<style scoped src="./status-shared.css"></style>

<style scoped>
.graph-key {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 24px;
	margin: 0 0 12px;
	padding: 0;
	color: var(--vp-c-text-2);
	font-size: 13px;
	list-style: none;

	li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
}

/* Four dots, as on a development tooling line. */
.graph-key-tooling {
	fill: none;
	stroke: var(--vp-c-text-2);
	stroke-linecap: round;
	stroke-width: 3;
	stroke-dasharray: 0 5;
}

/* Thin, as a line that waits. */
.graph-key-waiting {
	fill: none;
	stroke: var(--vp-c-text-2);
	stroke-linecap: round;
	stroke-width: 1.5;
}

.graph {
	position: relative;
}

.graph-head {
	position: absolute;
	inset: 0 0 auto;
	height: 32px;
	border-bottom: 1px solid var(--vp-c-divider);
	color: var(--vp-c-text-2);
	font-size: 13px;
	font-weight: 500;

	span {
		position: absolute;
		top: 6px;
	}
}

.graph-group {
	position: absolute;
	left: 36px;
	margin: 0;
	color: var(--vp-c-text-1);
	font-size: 13px;
	font-weight: 600;
	line-height: 20px;
}

.graph-row {
	position: absolute;
	inset-inline: 0;
	border-bottom: 1px solid var(--vp-c-divider);

	&.banded {
		background: var(--vp-c-bg-soft);
	}

	&.active {
		background: var(--vp-c-brand-soft);
	}

	> span {
		position: absolute;
		pointer-events: none;
	}

	a {
		pointer-events: auto;
	}

	&.faint > span {
		opacity: 0.35;
	}
}

/* Behind everything else in the row, so that its links stay links. */
.graph-row-select {
	position: absolute;
	inset: 0;
	width: 100%;
	cursor: pointer;

	&:focus-visible {
		outline-offset: -2px;
	}
}

.row-position {
	box-sizing: border-box;
	top: 11px;
	left: 0;
	width: 36px;
	padding-right: 12px;
	color: var(--vp-c-text-2);
	font-variant-numeric: tabular-nums;
	text-align: right;
}

.row-name {
	top: 4px;
	left: 36px;
	width: 252px;
	line-height: 18px;

	a {
		display: block;
		min-width: 0;
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
}

/* The name, and stacked the place in the queue before it. */
.row-title {
	display: flex;
	gap: 6px;
	align-items: baseline;
}

.row-number {
	color: var(--vp-c-text-2);
	font-variant-numeric: tabular-nums;
}

.row-packages {
	display: block;
	overflow: hidden;
	color: var(--vp-c-text-2);
	font-size: 12px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.row-summary {
	top: 11px;
	color: var(--vp-c-text-2);
	font-size: 13px;
	white-space: nowrap;
}

/* Both sit on a centre line given as their `top`. */
.row-behind,
.row-update {
	display: inline-flex;
	align-items: baseline;
	gap: 8px;
	font-size: 13px;
	line-height: 20px;
	white-space: nowrap;
	transform: translateY(-50%);
}

.row-behind {
	gap: 2px;
	font-weight: 500;
}

.row-update {
	a {
		font-weight: 600;
	}

	.tooling {
		margin-left: 0;
	}
}

.behind-major {
	color: var(--vp-c-danger-1);
}

.behind-minor {
	color: var(--vp-c-warning-1);
}

.behind-patch {
	color: var(--vp-c-text-2);
}

.graph-lines {
	position: absolute;
	top: 0;
	overflow: visible;
	pointer-events: none;

	.faint {
		opacity: 0.15;
	}
}

.lane-halo {
	fill: none;
	stroke: var(--lane);
	stroke-linecap: round;
	stroke-linejoin: round;
	stroke-opacity: 0.22;
	stroke-width: 11;
}

.lane-line {
	fill: none;
	stroke: var(--lane);
	stroke-linecap: round;
	stroke-width: 3;

	/*
	 * Thickness says whether it is behind now or only waits; round dots say it is
	 * only development tooling. Unlike dashes, dots cannot be mistaken for a line.
	 */
	&.tooling {
		stroke-dasharray: 0 5;
	}

	&.waiting {
		stroke-width: 1.5;
	}
}

.lane-head {
	fill: var(--lane);
}

.graph-dot {
	fill: var(--lane);
}

.row-wait {
	color: var(--vp-c-text-3);
}

.graph-node {
	stroke: var(--vp-c-bg);
	stroke-width: 2;
}

.graph-label {
	font-size: 13px;
	font-weight: 600;
	/* A later lane passes behind a label; an outline in the colour of the row hides it there. */
	paint-order: stroke;
	stroke: var(--row-bg);
	stroke-linejoin: round;
	stroke-width: 5px;
}

/*
 * Stacked, for phones: all text starts right of the lanes and keeps to the width
 * of the screen. Every line is 18 high and never wraps, so that the heights the
 * layout gave the rows hold; what does not fit is cut off.
 */
.narrow .graph-group {
	left: var(--text-left);
	right: 0;
	line-height: 18px;
}

.narrow .row-name {
	left: var(--text-left);
	right: 0;
	width: auto;
}

.narrow :is(.row-summary, .row-behind, .row-update) {
	left: var(--text-left);
	right: 0;
	overflow: hidden;
	line-height: 18px;
	text-overflow: ellipsis;
}

.narrow .row-behind a {
	margin-left: 6px;
	font-weight: 600;
}

.narrow .lane-halo {
	stroke-width: 7;
}

.narrow .lane-line:not(.waiting) {
	stroke-width: 2.5;
}
</style>
