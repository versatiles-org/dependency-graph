<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { data } from '../../../status.data';
import type { Status } from '../../../scripts/dependency-graph/drift';
import {
	daysAgo,
	filterDrift,
	formatUtc,
	hoursAgo,
	isCommand,
	isDev,
	isStale,
} from '../../../scripts/dependency-graph/status-view';

/** The same marks as the terminal report, so colour never has to speak alone. */
const STATUS: Record<Status, { mark: string; label: string; count: string }> = {
	range: { mark: '✗', label: 'Range excludes latest', count: 'ranges exclude latest' },
	'stale-lock': { mark: '↑', label: 'Lockfile behind', count: 'lockfiles behind' },
	unknown: { mark: '?', label: 'Unknown', count: 'unknown' },
	ahead: { mark: '»', label: 'Ahead of latest', count: 'ahead of latest' },
	current: { mark: '✓', label: 'Current', count: 'current' },
};
const ORDER = Object.keys(STATUS) as Status[];

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

/** What the most recently pressed copy button says for a moment. */
const copyResult = ref<{ key: string; label: string } | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copy(key: string, text: string): Promise<void> {
	let label = 'Copied';
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		// Refused, or missing outside HTTPS. The command stays on screen to select by hand.
		label = 'Copy failed';
	}
	copyResult.value = { key, label };
	clearTimeout(copyTimer);
	copyTimer = setTimeout(() => {
		copyResult.value = null;
	}, 1500);
}

const copyLabel = (key: string): string =>
	copyResult.value?.key === key ? copyResult.value.label : 'Copy';
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
							{{ STATUS[status].count }}
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
					<h2>Update queue</h2>
					<p class="hint">
						Work from the top. Each repository comes after the ones it builds on, so nothing
						has to be updated twice.
					</p>
					<div v-if="filtered.queue.length > 0" class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th class="position" scope="col">
										<span class="sr-only">Position</span>
									</th>
									<th scope="col">Repository</th>
									<th scope="col">Package</th>
									<th scope="col">Update</th>
									<th scope="col">Range</th>
									<th scope="col">Behind</th>
									<th scope="col">Fix</th>
								</tr>
							</thead>
							<tbody v-for="entry in filtered.queue" :key="entry.consumer">
								<tr
									v-for="(row, index) in entry.outdated"
									:key="`${row.name} ${row.path} ${row.section}`"
								>
									<td v-if="index === 0" class="position" :rowspan="entry.outdated.length">
										{{ entry.position }}
									</td>
									<th
										v-if="index === 0"
										class="repo"
										scope="rowgroup"
										:rowspan="entry.outdated.length"
									>
										<a :href="repoUrl(entry.consumer)">{{ entry.consumer }}</a>
									</th>
									<td class="package">
										<span
											class="mark"
											:class="`is-${row.status}`"
											:title="STATUS[row.status].label"
										>
											{{ STATUS[row.status].mark }}
										</span>
										<a :href="fileUrl(row.consumer, row.path)">{{ row.name }}</a>
										<span v-if="isDev(row)" class="dev">dev</span>
										<span v-if="row.path.includes('/')" class="path">{{ row.path }}</span>
									</td>
									<td class="mono nowrap">
										{{ row.installed ?? '—' }} → {{ row.latest ?? '?' }}
									</td>
									<td class="mono nowrap dim">{{ row.requested }}</td>
									<td>{{ row.behind ?? '—' }}</td>
									<td class="fix">
										<template v-if="row.fix && isCommand(row.fix)">
											<code>{{ row.fix }}</code>
											<button
												type="button"
												class="copy"
												@click="
													copy(`${entry.consumer} ${row.name} ${row.path}`, row.fix!)
												"
											>
												{{ copyLabel(`${entry.consumer} ${row.name} ${row.path}`) }}
											</button>
										</template>
										<template v-else>{{ row.fix ?? '—' }}</template>
									</td>
								</tr>
							</tbody>
						</table>
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

	box-sizing: border-box;
	max-width: 1228px;
	margin-inline: auto;
	padding: 32px 24px 96px;
	font-size: 14px;
	line-height: 1.5;
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

.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
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

td.position {
	color: var(--vp-c-text-2);
	font-variant-numeric: tabular-nums;
	text-align: right;
}

th.position,
td.position {
	width: 2.2em;
	padding-right: 10px;
}

th.repo {
	font-weight: 600;
	white-space: nowrap;
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

.fix {
	min-width: 300px;
}

.fix code {
	margin-right: 8px;
}

.copy {
	padding: 0 7px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 4px;
	color: var(--vp-c-text-2);
	font-size: 12px;
	line-height: 1.5;
}

.copy:hover {
	border-color: var(--vp-c-brand-1);
	color: var(--vp-c-brand-1);
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
