<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { data } from '../../../status.data';
import type { PinFinding, Status } from '../../../scripts/dependency-graph/drift';
import {
	daysAgo,
	filterDrift,
	formatUtc,
	hoursAgo,
	isDev,
	isStale,
	pinLocation,
} from '../../../scripts/dependency-graph/status-view';
import { buildQueueGraph, type GraphEdge } from '../../../scripts/dependency-graph/queue-graph';

/** The same marks as the terminal report, so colour never has to speak alone. */
const STATUS: Record<Status, { mark: string; label: string; count: string }> = {
	range: { mark: '✗', label: 'Range excludes latest', count: 'ranges exclude latest' },
	'stale-lock': { mark: '↑', label: 'Lockfile behind', count: 'lockfiles behind' },
	unknown: { mark: '?', label: 'Unknown', count: 'unknown' },
	ahead: { mark: '»', label: 'Ahead of latest', count: 'ahead of latest' },
	current: { mark: '✓', label: 'Current', count: 'current' },
};
const ORDER = Object.keys(STATUS) as Status[];

/** A pin has no range to change, so behind is drawn like a stale lockfile, as in the terminal. */
const PIN_STATUS: Record<PinFinding['status'], { mark: string; tone: Status }> = {
	behind: { mark: '↑', tone: 'stale-lock' },
	unknown: { mark: '?', tone: 'unknown' },
	ahead: { mark: '»', tone: 'ahead' },
	current: { mark: '✓', tone: 'current' },
};

const report = data?.drift.status === 'ok' ? data.drift.data : null;
const driftError = data?.drift.status === 'failed' ? data.drift.error : null;

/** Unknown until mounted: the server must not bake an age into the page. */
const now = ref<Date | null>(null);
onMounted(() => {
	now.value = new Date();
});

const snapshotAge = computed(() =>
	data && now.value ? hoursAgo(data.generatedAt, now.value) : null,
);
const stale = computed(() => Boolean(data && now.value && isStale(data.generatedAt, now.value)));

const query = ref('');
const hideDev = ref(false);
const onlyOutdated = ref(true);
const filtered = computed(() =>
	report
		? filterDrift(report, {
				query: query.value,
				hideDev: hideDev.value,
				onlyOutdated: onlyOutdated.value,
			})
		: { queue: [], packages: [] },
);
const filtering = computed(() => query.value.trim() !== '' || hideDev.value);

/** One tick per usage, worst first. */
const ticks = computed(() =>
	report
		? ORDER.flatMap((status) => Array<Status>(report.totals.byStatus[status]).fill(status))
		: [],
);
const legend = computed(() =>
	report ? ORDER.filter((status) => report.totals.byStatus[status] > 0) : [],
);

const repoUrl = (repo: string): string => `https://github.com/${data?.org}/${repo}`;
const fileUrl = (repo: string, path: string): string => `${repoUrl(repo)}/blob/HEAD/${path}`;

const graph = computed(() => buildQueueGraph(filtered.value.queue, report?.publishes ?? {}));

/* Where the columns start, around a graph as wide as it has lanes. */
const GRAPH_LEFT = 296;
const behindLeft = computed(() => GRAPH_LEFT + graph.value.width);
const updateLeft = computed(() => behindLeft.value + 88);
const graphMinWidth = computed(() => updateLeft.value + 240);

/** Pointing at a row isolates its lines, and clicking keeps them isolated. */
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
const togglePin = (repo: string): void => {
	pinned.value = pinned.value === repo ? null : repo;
};

/** The first package ends up on top: later ones are painted first, each halo under its lines. */
const paintOrder = computed(() => [...graph.value.lanes].reverse());
const laneColor = (index: number): string => `var(--st-lane-${index % 6})`;
</script>

<template>
	<div class="status-page">
		<h1>Status</h1>

		<p v-if="!data" class="notice">
			No snapshot in this build. Run <code>npm run sync:deps</code> to create one.
		</p>

		<template v-else>
			<p class="snapshot" :class="{ stale }">
				Snapshot from {{ formatUtc(data.generatedAt) }}
				<template v-if="snapshotAge">({{ snapshotAge }})</template>
				<template v-if="stale"
					>. Scheduled runs may have stopped, so this can be out of date.</template
				>
			</p>

			<p v-if="driftError" class="notice failed">
				Versions were not checked in this snapshot, and the next scheduled run tries again.
				<code>{{ driftError }}</code>
			</p>

			<template v-if="report">
				<section class="overview" aria-label="Summary">
					<div
						class="strip"
						role="img"
						:aria-label="`${report.totals.usages} usages of ${report.packages.length} packages`"
					>
						<span
							v-for="(status, index) in ticks"
							:key="index"
							class="tick"
							:class="`is-${status}`"
						/>
					</div>
					<ul class="legend">
						<li v-for="status in legend" :key="status" :class="`is-${status}`">
							<span class="mark" aria-hidden="true">{{ STATUS[status].mark }}</span>
							<strong>{{ report.totals.byStatus[status] }}</strong>
							{{
								report.totals.byStatus[status] === 1
									? STATUS[status].label.toLowerCase()
									: STATUS[status].count
							}}
						</li>
						<li>
							<strong>{{ report.totals.pinsBehind }}</strong>
							pinned behind
						</li>
						<li>
							<strong>{{ report.totals.deploymentsBehind }}</strong>
							deployed behind
						</li>
					</ul>
				</section>

				<div class="filters">
					<label class="search">
						<span>Filter</span>
						<input v-model="query" type="search" placeholder="Repository or package" />
					</label>
					<label class="toggle">
						<input v-model="hideDev" type="checkbox" />
						Hide development dependencies
					</label>
				</div>

				<section>
					<h2>Outdated dependencies</h2>
					<p class="hint">
						Work from the top. Each repository comes after the ones it builds on, so nothing
						has to be updated twice.
					</p>
					<ul class="graph-key">
						<li>
							Each colour is one package. A line curves up into the package it depends on.
						</li>
						<li>
							<svg width="32" height="8" viewBox="0 0 32 8" aria-hidden="true">
								<path d="M 0 4 L 32 4" class="graph-key-dash" />
							</svg>
							Development dependency
						</li>
						<li>Point at a row to isolate its lines, or click to keep them isolated.</li>
					</ul>
					<div v-if="graph.rows.length > 0" class="scroll" tabindex="0">
						<div
							class="graph"
							:style="{ height: `${graph.height}px`, minWidth: `${graphMinWidth}px` }"
						>
							<div class="graph-head">
								<span :style="{ left: '36px' }">Repository and package</span>
								<span :style="{ left: `${GRAPH_LEFT}px` }">Dependencies</span>
								<span :style="{ left: `${behindLeft}px` }">Behind</span>
								<span :style="{ left: `${updateLeft}px` }">Update</span>
							</div>
							<h3 v-if="graph.hasReleases" class="graph-group" :style="{ top: '40px' }">
								Latest releases
							</h3>
							<h3 class="graph-group" :style="{ top: `${graph.queueLabelTop}px` }">
								Repositories to update, in order
							</h3>

							<div
								v-for="(row, index) in graph.rows"
								:key="row.repo"
								class="graph-row"
								:class="{
									'in-queue': row.position !== null,
									banded: row.position !== null && index % 2 === 0,
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
									:aria-label="`Isolate the lines of ${row.repo}`"
									@click="togglePin(row.repo)"
									@focus="hovered = row.repo"
									@blur="hovered = null"
								/>
								<span class="row-position">{{ row.position }}</span>
								<span class="row-name">
									<a
										:href="repoUrl(row.repo)"
										:style="
											row.lane !== null ? { color: laneColor(row.lane) } : undefined
										"
										>{{ row.repo }}</a
									>
									<span class="row-packages" :title="row.packages">{{
										row.packages
									}}</span>
								</span>
								<span
									v-if="row.latest"
									class="row-summary"
									:style="{ left: `${behindLeft}px` }"
								>
									Latest <span class="mono">{{ row.latest }}</span
									>, {{ row.behindCount }}
									{{ row.behindCount === 1 ? 'repository' : 'repositories' }} behind
								</span>
								<template
									v-for="detail in row.details"
									:key="`${detail.name} ${detail.path} ${detail.section}`"
								>
									<span
										class="row-behind"
										:class="[`is-${detail.status}`, `behind-${detail.behind}`]"
										:style="{ left: `${behindLeft}px`, top: `${detail.y}px` }"
										:title="STATUS[detail.status].label"
									>
										<span class="mark" aria-hidden="true">{{
											STATUS[detail.status].mark
										}}</span>
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
										<span v-if="isDev(detail)" class="dev">dev</span>
									</span>
								</template>
							</div>

							<svg
								class="graph-lines"
								:width="graph.width"
								:height="graph.height"
								:viewBox="`0 0 ${graph.width} ${graph.height}`"
								:style="{ left: `${GRAPH_LEFT}px` }"
								aria-hidden="true"
							>
								<g
									v-for="lane in paintOrder"
									:key="lane.repo"
									:style="{ '--lane': laneColor(lane.index) }"
									:class="{ faint: !laneLit(lane) }"
								>
									<path class="lane-halo" :d="lane.halo" />
									<path class="lane-line" :d="lane.line" />
									<path class="lane-head" :d="lane.heads" />
									<path
										v-for="edge in lane.edges"
										:key="edge.consumer"
										class="lane-line"
										:class="{ dashed: edge.dashed, faint: !edgeLit(edge) }"
										:d="edge.line"
									/>
								</g>
								<g
									v-for="row in graph.rows"
									:key="row.repo"
									:class="{ faint: !rowLit(row.repo) }"
								>
									<circle
										class="graph-node"
										:cx="row.nodeX"
										:cy="row.y"
										r="7"
										:style="{
											fill:
												row.lane !== null ? laneColor(row.lane) : 'var(--vp-c-text-2)',
										}"
									/>
									<text
										v-if="row.lane !== null"
										class="graph-label"
										:x="row.nodeX + 12"
										:y="row.y + 4"
										:style="{ fill: laneColor(row.lane) }"
									>
										{{ graph.lanes[row.lane].label }}
									</text>
								</g>
							</svg>
						</div>
					</div>
					<p v-else class="empty">
						{{ filtering ? 'No outdated usage matches the filter.' : 'Nothing to update.' }}
					</p>
				</section>

				<section>
					<div class="heading">
						<h2>Packages</h2>
						<label class="toggle">
							<input v-model="onlyOutdated" type="checkbox" />
							Hide fully current packages
						</label>
					</div>
					<div v-if="filtered.packages.length > 0" class="packages">
						<details
							v-for="entry in filtered.packages"
							:key="`${entry.ecosystem} ${entry.name}`"
						>
							<summary>
								<span
									class="mark"
									:class="`is-${entry.usages[0].status}`"
									aria-hidden="true"
								>
									{{ STATUS[entry.usages[0].status].mark }}
								</span>
								<span class="name">
									{{ entry.name }}
									<span class="ecosystem">{{ entry.ecosystem }}</span>
								</span>
								<span class="mono latest">{{ entry.release?.version ?? '?' }}</span>
								<span class="released">
									<template v-if="entry.release?.source === 'manifest'">
										Not published, version on main
									</template>
									<template v-else-if="entry.release?.date">
										{{
											now
												? daysAgo(entry.release.date, now)
												: entry.release.date.slice(0, 10)
										}}
									</template>
								</span>
								<span class="spread mono">
									<span v-for="item in entry.spread" :key="item.version">
										{{ item.version }} ×{{ item.count }}
									</span>
								</span>
							</summary>
							<div class="scroll" tabindex="0">
								<table>
									<thead>
										<tr>
											<th scope="col">Used by</th>
											<th scope="col">Installed</th>
											<th scope="col">Range</th>
											<th scope="col">State</th>
										</tr>
									</thead>
									<tbody>
										<tr
											v-for="row in entry.usages"
											:key="`${row.consumer} ${row.path} ${row.section}`"
										>
											<td class="package">
												<a :href="fileUrl(row.consumer, row.path)">{{
													row.consumer
												}}</a>
												<span v-if="isDev(row)" class="dev">dev</span>
												<span v-if="row.path.includes('/')" class="path">{{
													row.path
												}}</span>
											</td>
											<td class="mono nowrap">{{ row.installed ?? '—' }}</td>
											<td class="mono nowrap dim">{{ row.requested }}</td>
											<td>
												<span
													class="mark"
													:class="`is-${row.status}`"
													aria-hidden="true"
												>
													{{ STATUS[row.status].mark }}
												</span>
												{{ STATUS[row.status].label }}
											</td>
										</tr>
									</tbody>
								</table>
							</div>
						</details>
					</div>
					<p v-else class="empty">
						{{
							filtering
								? 'No package matches the filter.'
								: 'Every package is current everywhere it is used.'
						}}
					</p>
				</section>

				<section v-if="report.pins.length > 0">
					<h2>Pinned releases</h2>
					<p class="hint">
						Exact releases named in a file, an image tag or the notes of a release that
						bundles them. References to the latest release are not listed, because they cannot
						fall behind.
					</p>
					<div class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Repository</th>
									<th scope="col">Pinned in</th>
									<th scope="col">Pinned</th>
									<th scope="col">Latest</th>
									<th scope="col">From</th>
									<th scope="col">State</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="pin in report.pins"
									:key="`${pin.repo} ${pinLocation(pin)} ${pin.provider}`"
								>
									<td class="nowrap">
										<a :href="repoUrl(pin.repo)">{{ pin.repo }}</a>
									</td>
									<td class="nowrap">
										<a v-if="pin.path" :href="fileUrl(pin.repo, pin.path)">{{
											pin.path
										}}</a>
										<a
											v-else-if="pin.image"
											:href="`https://hub.docker.com/r/${pin.image}`"
											>{{ pin.image }}</a
										>
										<a
											v-else
											:href="`${repoUrl(pin.repo)}/releases/${pin.tag ? `tag/${pin.tag}` : 'latest'}`"
											>{{ pinLocation(pin) }}</a
										>
									</td>
									<td class="mono nowrap">{{ pin.pinned ?? '—' }}</td>
									<td class="mono nowrap">{{ pin.latest?.version ?? '—' }}</td>
									<td class="nowrap">
										<a v-if="pin.provider" :href="repoUrl(pin.provider)">{{
											pin.provider
										}}</a>
										<template v-else>—</template>
									</td>
									<td>
										<span
											class="mark"
											:class="`is-${PIN_STATUS[pin.status].tone}`"
											aria-hidden="true"
										>
											{{ PIN_STATUS[pin.status].mark }}
										</span>
										{{ pin.status === 'current' ? 'Current' : pin.note }}
										<template v-if="pin.behind">({{ pin.behind }} behind)</template>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</section>

				<section v-if="report.deployments.length > 0">
					<h2>Deployments</h2>
					<div
						v-for="deployment in report.deployments"
						:key="deployment.repo"
						class="deployment"
					>
						<p class="deployment-name">
							<a :href="repoUrl(deployment.repo)">{{ deployment.repo }}</a>
							<span v-if="deployment.updated" class="dim">
								updated
								{{
									now ? daysAgo(deployment.updated, now) : deployment.updated.slice(0, 10)
								}}
							</span>
						</p>
						<p v-if="!deployment.reachable" class="notice failed">
							Could not read the versions from <code>{{ deployment.url }}</code
							>.
						</p>
						<div v-else class="scroll" tabindex="0">
							<table>
								<thead>
									<tr>
										<th scope="col">Component</th>
										<th scope="col">Running</th>
										<th scope="col">Latest</th>
										<th scope="col">From</th>
										<th scope="col">State</th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="row in deployment.findings" :key="row.component">
										<td>{{ row.component }}</td>
										<td class="mono nowrap">{{ row.deployed ?? '—' }}</td>
										<td class="mono nowrap">{{ row.latest?.version ?? '—' }}</td>
										<td>
											<a v-if="row.provider" :href="repoUrl(row.provider)">{{
												row.provider
											}}</a>
											<template v-else>—</template>
										</td>
										<td>
											{{ row.status === 'current' ? 'Current' : row.note }}
											<template v-if="row.behind">({{ row.behind }} behind)</template>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</section>
			</template>
		</template>
	</div>
</template>

<style scoped>
.status-page {
	--st-range: var(--vp-c-danger-1);
	--st-stale-lock: var(--vp-c-warning-1);
	--st-unknown: var(--vp-c-purple-1);
	--st-ahead: var(--vp-c-text-2);
	--st-current: var(--vp-c-success-1);

	/* One colour per lane of the graph; these differ in lightness as well as in hue. */
	--st-lane-0: #6a2f9e;
	--st-lane-1: #0b6fb8;
	--st-lane-2: #c2570a;
	--st-lane-3: #0f7a5f;
	--st-lane-4: #a61e4d;
	--st-lane-5: #4c5ab4;

	box-sizing: border-box;
	max-width: 1228px;
	margin-inline: auto;
	padding: 32px 24px 96px;
	font-size: 14px;
	line-height: 1.5;
}

/* A plain descendant selector, so that `.dark` stays a real ancestor under scoped CSS. */
.dark .status-page {
	--st-lane-0: #c49bf0;
	--st-lane-1: #6db8f0;
	--st-lane-2: #f0a060;
	--st-lane-3: #5fd0ac;
	--st-lane-4: #f08aa8;
	--st-lane-5: #a3acf0;
}

h1 {
	margin: 0 0 4px;
	color: var(--vp-c-text-1);
	font-size: 28px;
	font-weight: 600;
	line-height: 1.3;
}

.is-range {
	--st-color: var(--st-range);
}
.is-stale-lock {
	--st-color: var(--st-stale-lock);
}
.is-unknown {
	--st-color: var(--st-unknown);
}
.is-ahead {
	--st-color: var(--st-ahead);
}
.is-current {
	--st-color: var(--st-current);
}

a {
	color: var(--vp-c-brand-1);
	text-decoration: none;
}

a:hover {
	color: var(--vp-c-brand-2);
	text-decoration: underline;
}

:is(a, button, input, summary, .scroll):focus-visible {
	outline: 2px solid var(--vp-c-brand-1);
	outline-offset: 2px;
}

code,
.mono {
	font-family: var(--vp-font-family-mono);
	font-size: 13px;
}

.dim {
	color: var(--vp-c-text-2);
}

.nowrap {
	white-space: nowrap;
}

section {
	margin-top: 40px;
}

h2 {
	margin: 0;
	color: var(--vp-c-text-1);
	font-size: 20px;
	font-weight: 600;
	line-height: 1.4;
}

.hint {
	margin: 2px 0 12px;
	color: var(--vp-c-text-2);
}

.heading {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: 4px 16px;
	margin-bottom: 12px;
}

/* Snapshot and notices --------------------------------------------------- */

.snapshot {
	margin: 0;
	color: var(--vp-c-text-2);
}

.snapshot.stale {
	color: var(--vp-c-warning-1);
	font-weight: 500;
}

.notice {
	margin: 12px 0 0;
	padding: 10px 14px;
	border-left: 3px solid var(--vp-c-divider);
	background: var(--vp-c-bg-soft);
}

.notice.failed {
	border-left-color: var(--vp-c-danger-1);
}

.notice code {
	overflow-wrap: anywhere;
}

.empty {
	margin: 8px 0 0;
	color: var(--vp-c-text-2);
}

/* Summary: one tick for each place an organisation package is used --------- */

.overview {
	margin-top: 20px;
}

.strip {
	display: flex;
	gap: 2px;
	height: 28px;
}

.tick {
	flex: 1 1 0;
	min-width: 1px;
	background: var(--st-color);
}

.legend {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 24px;
	margin: 10px 0 0;
	padding: 0;
	list-style: none;
}

.legend li {
	color: var(--vp-c-text-2);
}

.legend strong {
	color: var(--vp-c-text-1);
	font-weight: 600;
}

.legend .mark {
	margin-right: 2px;
}

.mark {
	display: inline-block;
	width: 1.1em;
	color: var(--st-color);
	font-weight: 700;
	text-align: center;
}

/* Filters ---------------------------------------------------------------- */

.filters {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 24px;
	margin-top: 24px;
}

.search {
	display: flex;
	flex: 0 1 340px;
	align-items: center;
	gap: 8px;
	color: var(--vp-c-text-2);
}

.search input {
	flex: 1;
	min-width: 0;
	padding: 4px 10px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 6px;
	background: var(--vp-c-bg);
	color: var(--vp-c-text-1);
	font-size: 14px;
}

.toggle {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: var(--vp-c-text-2);
	font-size: 13px;
	cursor: pointer;
}

.toggle input {
	accent-color: var(--vp-c-brand-1);
}

/* Tables ----------------------------------------------------------------- */

.scroll {
	overflow-x: auto;
}

table {
	width: 100%;
	border-collapse: collapse;
}

th,
td {
	padding: 6px 12px 6px 0;
	border-bottom: 1px solid var(--vp-c-divider);
	text-align: left;
	vertical-align: top;
}

thead th {
	color: var(--vp-c-text-2);
	font-size: 13px;
	font-weight: 500;
}

/* The table scrolls sideways when narrow, so a name never has to break from its mark. */
.package {
	white-space: nowrap;
}

.dev {
	margin-left: 6px;
	padding: 0 5px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 4px;
	color: var(--vp-c-text-2);
	font-size: 12px;
}

.path {
	display: block;
	margin-left: 1.1em;
	color: var(--vp-c-text-2);
	font-size: 12px;
}

/* Outdated dependencies: rows with a graph drawn across them -------------- */

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
}

.graph-key li {
	display: flex;
	align-items: center;
	gap: 8px;
}

.graph-key-dash {
	fill: none;
	stroke: var(--vp-c-text-2);
	stroke-width: 3;
	stroke-dasharray: 6 4;
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
}

.graph-head span {
	position: absolute;
	top: 6px;
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
}

.graph-row.banded {
	background: var(--vp-c-bg-soft);
}

.graph-row.active {
	background: var(--vp-c-brand-soft);
}

/* Behind everything else in the row, so that its links stay links. */
.graph-row-select {
	position: absolute;
	inset: 0;
	width: 100%;
	cursor: pointer;
}

.graph-row-select:focus-visible {
	outline-offset: -2px;
}

.graph-row > span {
	position: absolute;
	pointer-events: none;
}

.graph-row a {
	pointer-events: auto;
}

.graph-row.faint > span {
	opacity: 0.35;
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
}

.row-name a {
	display: block;
	overflow: hidden;
	font-weight: 600;
	text-overflow: ellipsis;
	white-space: nowrap;
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

.row-update a {
	font-weight: 600;
}

.row-update .dev {
	margin-left: 0;
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
}

.lane-line.dashed {
	stroke-dasharray: 6 4;
}

.lane-head {
	fill: var(--lane);
}

.graph-node {
	stroke: var(--vp-c-bg);
	stroke-width: 2;
}

.graph-label {
	font-size: 13px;
	font-weight: 600;
}

.graph-lines .faint {
	opacity: 0.15;
}

/* Packages --------------------------------------------------------------- */

.packages {
	border-top: 1px solid var(--vp-c-divider);
}

details {
	border-bottom: 1px solid var(--vp-c-divider);
}

summary {
	display: grid;
	grid-template-columns: 1.3em minmax(220px, 2fr) 70px minmax(100px, 1fr) minmax(180px, 3fr);
	gap: 2px 12px;
	align-items: baseline;
	padding: 7px 0;
	cursor: pointer;
}

summary:hover .name {
	color: var(--vp-c-brand-1);
}

.name {
	font-weight: 600;
}

.ecosystem {
	margin-left: 4px;
	color: var(--vp-c-text-2);
	font-size: 12px;
	font-weight: 400;
}

.released {
	color: var(--vp-c-text-2);
}

.spread {
	display: flex;
	flex-wrap: wrap;
	gap: 0 14px;
	color: var(--vp-c-text-2);
}

details .scroll {
	margin: 0 0 12px 1.9em;
}

details tr:last-child td {
	border-bottom: 0;
}

/* Deployments ------------------------------------------------------------ */

.deployment-name {
	display: flex;
	flex-wrap: wrap;
	gap: 0 10px;
	align-items: baseline;
	margin: 8px 0;
	font-weight: 600;
}

.deployment-name .dim {
	font-weight: 400;
}

@media (max-width: 720px) {
	summary {
		grid-template-columns: 1.3em minmax(0, 1fr) auto;
	}

	.released,
	.spread {
		grid-column: 2 / -1;
	}

	details .scroll {
		margin-left: 0;
	}
}
</style>
