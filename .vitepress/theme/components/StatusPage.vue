<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { data } from '../../../status.data';
import type { PinFinding, Status } from '../../../scripts/dependency-graph/drift';
import {
	countOpen,
	daysAgo,
	githubUrl,
	filterDeployments,
	filterDrift,
	filterPins,
	formatDate,
	listRepos,
	pinLocation,
	CI_STATE,
	STATUS,
	waitingOn,
} from '../../../scripts/dependency-graph/status-view';
import QueueGraph from './QueueGraph.vue';
import SnapshotNote from './SnapshotNote.vue';
import TabBar from './TabBar.vue';
import type { Tab } from './tabs';

const ORDER = Object.keys(STATUS) as Status[];

/** A pin has no range to change, so behind is drawn like a stale lockfile. */
const PIN_STATUS: Record<PinFinding['status'], { mark: string; tone: Status }> = {
	behind: { mark: '↑', tone: 'stale-lock' },
	unknown: { mark: '?', tone: 'unknown' },
	ahead: { mark: '»', tone: 'ahead' },
	current: { mark: '✓', tone: 'current' },
};

const report = data?.drift.status === 'ok' ? data.drift.data : null;
const driftError = data?.drift.status === 'failed' ? data.drift.error : null;
const repoStatus = data?.repos.status === 'ok' ? data.repos.data : null;
const reposError = data?.repos.status === 'failed' ? data.repos.error : null;

/** Unknown until mounted: the server must not bake an age into the page. */
const now = ref<Date | null>(null);
onMounted(() => {
	now.value = new Date();
});

const query = ref('');
const hideTooling = ref(false);
const onlyOutdated = ref(true);
const filtered = computed(() =>
	report
		? filterDrift(report, {
				query: query.value,
				hideTooling: hideTooling.value,
				onlyOutdated: onlyOutdated.value,
			})
		: { queue: [], packages: [] },
);
const filtering = computed(() => query.value.trim() !== '' || hideTooling.value);
const listedRepos = computed(() => listRepos(repoStatus ?? [], query.value));
const listedPins = computed(() => filterPins(report?.pins ?? [], query.value));
const listedDeployments = computed(() => filterDeployments(report?.deployments ?? [], query.value));
const when = (date: string): string => (now.value ? daysAgo(date, now.value) : formatDate(date));

/*
 * One tab for each part of the page. A tab's id is the id its section had, so
 * links to `#deployments` and the like still lead there.
 */
const openCounts = computed(() =>
	countOpen({
		queue: filtered.value.queue,
		packages: filtered.value.packages,
		pins: listedPins.value,
		deployments: listedDeployments.value,
		repos: listedRepos.value,
	}),
);
/** Which tabs there are depends on the snapshot alone, so a filter never removes one. */
const tabs = computed((): Tab[] => {
	const count = openCounts.value;
	const list: Tab[] = [];
	if (report) {
		list.push({
			id: 'outdated-dependencies',
			label: 'Outdated dependencies',
			count: count.queue,
			counted: count.queue === 1 ? 'repository to update' : 'repositories to update',
			tone: 'stale-lock',
		});
		if (report.pins.length > 0) {
			list.push({
				id: 'pinned-releases',
				label: 'Pinned releases',
				count: count.pins,
				counted: 'behind',
				tone: 'stale-lock',
			});
		}
		if (report.deployments.length > 0) {
			list.push({
				id: 'deployments',
				label: 'Deployments',
				count: count.deployments,
				counted: count.deployments === 1 ? 'component behind' : 'components behind',
				tone: 'stale-lock',
			});
		}
	}
	list.push({
		id: 'repositories',
		label: 'Repositories',
		count: repoStatus ? count.repos : null,
		counted: 'failing CI',
		tone: 'range',
	});
	if (report) {
		list.push({
			id: 'packages',
			label: 'Packages',
			count: count.packages,
			counted: 'behind',
			tone: 'stale-lock',
		});
	}
	return list;
});

const selected = ref(tabs.value[0].id);

/** What a pinned version or a running component needs, starting like the labels around it. */
function stateText(row: { status: string; note: string; behind: string | null }): string {
	if (row.status === 'current') return STATUS.current.label;
	const note = row.note.charAt(0).toUpperCase() + row.note.slice(1);
	return row.behind ? `${note} (${row.behind} behind)` : note;
}

/** One tick per usage, worst first. */
const ticks = computed(() =>
	report
		? ORDER.flatMap((status) => Array<Status>(report.totals.byStatus[status]).fill(status))
		: [],
);
const legend = computed(() =>
	report ? ORDER.filter((status) => report.totals.byStatus[status] > 0) : [],
);

const repoUrl = (repo: string): string => githubUrl(data?.org ?? '', repo);
const fileUrl = (repo: string, path: string): string => githubUrl(data?.org ?? '', repo, path);

/** Taken from the whole queue, so that a filter cannot hide why a repository waits. */
const waiting = report ? waitingOn(report) : {};
</script>

<template>
	<div class="status-page">
		<h1>Status</h1>

		<p v-if="!data" class="notice">
			No snapshot in this build. Run <code>npm run sync:deps</code> to create one.
		</p>

		<template v-else>
			<SnapshotNote :generated-at="data.generatedAt" />

			<p v-if="driftError" class="notice failed">
				The latest update could not check versions. The next one tries again.
				<code>{{ driftError }}</code>
			</p>

			<template v-if="report">
				<section class="overview" aria-label="Summary">
					<p class="strip-title">
						{{ report.totals.usages }} dependencies on {{ report.packages.length }} of our own
						packages
					</p>
					<div
						class="strip"
						role="img"
						:aria-label="`${report.totals.usages} dependencies on ${report.packages.length} packages`"
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
									? STATUS[status].one
									: STATUS[status].many
							}}
						</li>
					</ul>
				</section>
			</template>

			<!-- Above the tabs, because it narrows every one of them. -->
			<div class="filters">
				<label class="search">
					<span>Filter</span>
					<input v-model="query" type="search" placeholder="Repository or package" />
				</label>
				<label v-if="report" class="toggle">
					<input v-model="hideTooling" type="checkbox" />
					Hide development tooling
				</label>
			</div>

			<TabBar v-model="selected" :tabs="tabs" label="Parts of the status" />

			<template v-if="report">
				<section
					v-show="selected === 'outdated-dependencies'"
					id="outdated-dependencies-panel"
					role="tabpanel"
					aria-labelledby="outdated-dependencies"
				>
					<p class="hint">
						Work from the top. Each repository comes after the ones it builds on, so nothing
						has to be updated twice.
					</p>
					<QueueGraph
						v-if="filtered.queue.length > 0"
						:queue="filtered.queue"
						:publishes="report.publishes"
						:waiting="waiting"
						:org="data?.org ?? ''"
					/>
					<p v-else class="empty">
						{{
							filtering ? 'No outdated dependency matches the filter.' : 'Nothing to update.'
						}}
					</p>
				</section>

				<section
					v-if="report.pins.length > 0"
					v-show="selected === 'pinned-releases'"
					id="pinned-releases-panel"
					role="tabpanel"
					aria-labelledby="pinned-releases"
				>
					<p class="hint">
						Exact versions fixed in a file, an image tag or a bundled release. References to
						"latest" are left out, because they cannot fall behind.
					</p>
					<div v-if="listedPins.length > 0" class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Repository</th>
									<th scope="col">Pinned in</th>
									<th scope="col">Version</th>
									<th scope="col">Latest</th>
									<th scope="col">Released by</th>
									<th scope="col">State</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="pin in listedPins"
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
									<td class="nowrap">
										<span
											class="mark"
											:class="`is-${PIN_STATUS[pin.status].tone}`"
											aria-hidden="true"
										>
											{{ PIN_STATUS[pin.status].mark }}
										</span>
										{{ stateText(pin) }}
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-else class="empty">No pinned release matches the filter.</p>
				</section>

				<section
					v-if="report.deployments.length > 0"
					v-show="selected === 'deployments'"
					id="deployments-panel"
					role="tabpanel"
					aria-labelledby="deployments"
				>
					<p class="hint">What our public services run, compared with the latest releases.</p>
					<p v-if="listedDeployments.length === 0" class="empty">
						No deployment matches the filter.
					</p>
					<div
						v-for="deployment in listedDeployments"
						:key="deployment.repo"
						class="deployment"
					>
						<p class="deployment-name">
							<a :href="repoUrl(deployment.repo)">{{ deployment.repo }}</a>
							<span v-if="deployment.updated" class="dim">
								last deployed {{ when(deployment.updated) }}
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
										<th scope="col">Released by</th>
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
										<td class="nowrap">
											<span
												class="mark"
												:class="`is-${PIN_STATUS[row.status].tone}`"
												aria-hidden="true"
											>
												{{ PIN_STATUS[row.status].mark }}
											</span>
											{{ stateText(row) }}
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</section>
			</template>

			<!-- Outside the report: a failure there says nothing about the repositories. -->
			<section
				v-show="selected === 'repositories'"
				id="repositories-panel"
				role="tabpanel"
				aria-labelledby="repositories"
			>
				<p v-if="reposError" class="notice failed">
					The latest update could not check the repositories. The next one tries again.
					<code>{{ reposError }}</code>
				</p>
				<template v-else>
					<p class="hint">
						What is open, whether the default branch passes, and what is waiting to be
						released. Repositories with failing CI come first.
					</p>
					<div v-if="listedRepos.length > 0" class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Repository</th>
									<th scope="col">CI</th>
									<th scope="col">Issues</th>
									<th scope="col">Pull requests</th>
									<th scope="col">Last commit</th>
									<th scope="col">Latest release</th>
									<th scope="col">Unreleased commits</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="repo in listedRepos" :key="repo.name">
									<td class="nowrap">
										<a :href="repoUrl(repo.name)">{{ repo.name }}</a>
									</td>
									<td class="nowrap">
										<a
											v-if="repo.ci !== 'none'"
											class="ci"
											:class="`is-${CI_STATE[repo.ci].tone}`"
											:href="`${repoUrl(repo.name)}/actions`"
										>
											<span class="mark" aria-hidden="true">{{
												CI_STATE[repo.ci].mark
											}}</span>
											{{ CI_STATE[repo.ci].label }}
										</a>
										<span v-else class="dim">{{ CI_STATE.none.label }}</span>
									</td>
									<td class="count" :class="{ dim: repo.issues === 0 }">
										<a v-if="repo.issues > 0" :href="`${repoUrl(repo.name)}/issues`">{{
											repo.issues
										}}</a>
										<template v-else>0</template>
									</td>
									<td class="nowrap count" :class="{ dim: repo.pulls === 0 }">
										<a v-if="repo.pulls > 0" :href="`${repoUrl(repo.name)}/pulls`">{{
											repo.pulls
										}}</a>
										<template v-else>0</template>
										<span v-if="repo.botPulls > 0" class="dim">
											({{ repo.botPulls }} from bots)</span
										>
									</td>
									<td class="nowrap dim">
										{{ repo.lastCommit ? when(repo.lastCommit) : '—' }}
									</td>
									<td class="nowrap">
										<template v-if="repo.release">
											<a
												class="mono"
												:href="`${repoUrl(repo.name)}/releases/tag/${repo.release.tag}`"
												>{{ repo.release.tag }}</a
											>
											<span v-if="repo.release.date" class="dim release-date">
												{{ when(repo.release.date) }}</span
											>
										</template>
										<span v-else class="dim">—</span>
									</td>
									<td class="count" :class="{ dim: !repo.unreleased }">
										<a
											v-if="repo.unreleased && repo.release"
											:href="`${repoUrl(repo.name)}/compare/${repo.release.tag}...${repo.branch}`"
											>{{ repo.unreleased }}</a
										>
										<template v-else>{{ repo.unreleased ?? '—' }}</template>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-else class="empty">No repository matches the filter.</p>
				</template>
			</section>

			<template v-if="report">
				<section
					v-show="selected === 'packages'"
					id="packages-panel"
					role="tabpanel"
					aria-labelledby="packages"
				>
					<div class="heading">
						<p class="hint">
							Every package of ours that a repository depends on, and the versions in use.
							Open one to see who uses it.
						</p>
						<label class="toggle">
							<input v-model="onlyOutdated" type="checkbox" />
							Only show outdated packages
						</label>
					</div>
					<div v-if="filtered.packages.length > 0" class="packages">
						<div class="packages-head">
							<span></span>
							<span>Package</span>
							<span>Latest</span>
							<span>Released</span>
							<span>Versions in use</span>
						</div>
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
												: formatDate(entry.release.date)
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
												<span v-if="row.tooling" class="tooling">tooling</span>
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
								: 'Every package is up to date everywhere it is used.'
						}}
					</p>
				</section>
			</template>
		</template>
	</div>
</template>

<style scoped src="./status-shared.css"></style>
<style scoped src="./status-page.css"></style>

<style scoped>
/*
 * Only what already belonged together is nested, such as `.legend li`. Moving a
 * class of its own under a parent would raise its specificity and could change
 * which rule wins.
 */
/* Summary: one tick for each place an organisation package is used --------- */

.overview {
	margin-top: 20px;
}

.strip-title {
	margin: 0 0 6px;
	color: var(--vp-c-text-2);
	font-size: 13px;
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
	margin: 6px 0 0;
	padding: 0;
	list-style: none;

	li {
		color: var(--vp-c-text-2);
	}

	strong {
		color: var(--vp-c-text-1);
		font-weight: 600;
	}

	.mark {
		margin-right: 2px;
	}

	a {
		margin-left: 4px;
	}
}

/* The table scrolls sideways when narrow, so a name never has to break from its mark. */
.package {
	white-space: nowrap;
}

.path {
	display: block;
	margin-left: 1.1em;
	color: var(--vp-c-text-2);
	font-size: 12px;
}

/* Packages --------------------------------------------------------------- */

.packages {
	border-top: 1px solid var(--vp-c-divider);
}

details {
	border-bottom: 1px solid var(--vp-c-divider);

	.scroll {
		margin: 0 0 12px 1.9em;
	}

	tr:last-child td {
		border-bottom: 0;
	}
}

.packages-head,
summary {
	display: grid;
	grid-template-columns: 1.3em minmax(220px, 2fr) 70px minmax(100px, 1fr) minmax(180px, 3fr);
	gap: 2px 12px;
	align-items: baseline;
	padding: 7px 0;
}

.packages-head {
	border-bottom: 1px solid var(--vp-c-divider);
	color: var(--vp-c-text-2);
	font-size: 13px;
	font-weight: 500;
}

summary {
	cursor: pointer;

	&:hover .name {
		color: var(--vp-c-brand-1);
	}
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

/* Repositories ------------------------------------------------------------ */

/* A line break between two elements in a template leaves no space between them. */
.release-date {
	margin-left: 8px;
}

.ci {
	color: var(--st-color);

	&:hover {
		color: var(--st-color);
	}
}

/* Deployments ------------------------------------------------------------ */

.deployment-name {
	display: flex;
	flex-wrap: wrap;
	gap: 0 10px;
	align-items: baseline;
	margin: 8px 0;
	font-weight: 600;

	.dim {
		font-weight: 400;
	}
}

@media (max-width: 720px) {
	/* The columns stack here, so there is nothing for these headings to name. */
	.packages-head {
		display: none;
	}

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
