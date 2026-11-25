<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { data } from '../../../status.data';
import type { ClosedItem, OpenItem } from '../../../scripts/dependency-graph/issues';
import {
	backlog,
	backlogTotal,
	blocking,
	botGroups,
	dayBefore,
	humanPulls,
	matches,
	PROBLEMS,
	refUrl,
	searchUrl,
	shortRef,
	STALE_DRAFT_DAYS,
	STALE_ISSUE_DAYS,
	unreleasedByRepo,
	WAIT_DAYS,
	waitingOnUs,
	type BlockNode,
} from '../../../scripts/dependency-graph/issues-view';
import {
	CI_STATE,
	daysAgo,
	formatDate,
	githubUrl,
} from '../../../scripts/dependency-graph/status-view';
import BlockTree from './BlockTree.vue';
import SnapshotNote from './SnapshotNote.vue';
import TabBar from './TabBar.vue';
import type { Tab } from './tabs';

const org = data?.org ?? '';
const report = data?.issues.status === 'ok' ? data.issues.data : null;
const issuesError = data?.issues.status === 'failed' ? data.issues.error : null;
const repoStatus = data?.repos.status === 'ok' ? data.repos.data : null;

/** What is late or stale is decided at the snapshot's time, so the page agrees with its counts. */
const asOf = data ? new Date(data.generatedAt) : new Date(0);

/** Unknown until mounted: the server must not bake an age into the page. */
const now = ref<Date | null>(null);
onMounted(() => {
	now.value = new Date();
});
const when = (date: string): string => (now.value ? daysAgo(date, now.value) : formatDate(date));

const query = ref('');
const filtering = computed(() => query.value.trim() !== '');
const keep = <T extends { repo: string; title: string }>(list: T[]): T[] =>
	list.filter((entry) => matches(entry, query.value));

const open = report?.open ?? [];
const waiting = waitingOnUs(open, asOf);
const pulls = humanPulls(open, asOf);
const bots = botGroups(open);
const blocks = blocking(org, open);
const unreleased = report?.unreleased
	? unreleasedByRepo(report.unreleased, repoStatus ?? [])
	: null;
const unreleasedCount = unreleased?.reduce((sum, repo) => sum + repo.fixes.length, 0) ?? null;
const backlogRows = backlog(open, report?.closed ?? [], asOf);
const weekAgo = dayBefore(asOf, WAIT_DAYS);
const staleBefore = dayBefore(asOf, STALE_ISSUE_DAYS);

const listedWaiting = computed(() => waiting.filter((entry) => matches(entry.item, query.value)));
const listedPulls = computed(() => pulls.filter((row) => matches(row.item, query.value)));
const listedBots = computed(() =>
	bots
		.map((group) => ({
			...group,
			pulls: matches({ repo: '', title: group.name }, query.value)
				? group.pulls
				: keep(group.pulls),
		}))
		.filter((group) => group.pulls.length > 0),
);

/** A tree stays whole while any issue in it matches, so nothing hangs loose. */
const treeMatches = (node: BlockNode): boolean =>
	matches({ repo: node.ref.repo, title: node.item?.title ?? '' }, query.value) ||
	node.blocks.some(treeMatches);
const listedTrees = computed(() => blocks.trees.filter(treeMatches));
/** The blocked issues in the trees shown, each once however many trees it is in. */
const listedBlocked = computed(() => {
	const seen = new Set<string>();
	const walk = (node: BlockNode): void => {
		for (const child of node.blocks) {
			seen.add(`${child.ref.repo}#${child.ref.number}`);
			walk(child);
		}
	};
	listedTrees.value.forEach(walk);
	return seen.size;
});
const listedResolved = computed(() =>
	blocks.resolved.filter((entry) => matches(entry.item, query.value)),
);
const listedParents = computed(() =>
	blocks.parents.filter(
		(entry) =>
			matches({ repo: entry.ref.repo, title: entry.item?.title ?? '' }, query.value) ||
			keep(entry.children).length > 0,
	),
);
const listedUnreleased = computed(() =>
	(unreleased ?? [])
		.map((repo) => ({
			...repo,
			fixes: matches({ repo: repo.repo, title: '' }, query.value)
				? repo.fixes
				: keep(repo.fixes),
		}))
		.filter((repo) => repo.fixes.length > 0),
);
const listedBacklog = computed(() =>
	backlogRows.filter((row) => matches({ repo: row.repo, title: '' }, query.value)),
);
const listedTotal = computed(() => backlogTotal(listedBacklog.value));

/** Which tabs there are depends on the snapshot alone, so a filter never removes one. */
const tabs = computed((): Tab[] => {
	if (!report) return [];
	const overdue = listedWaiting.value.some((entry) => entry.overdue);
	const pullCount =
		listedPulls.value.length +
		listedBots.value.reduce((sum, group) => sum + group.pulls.length, 0);
	return [
		{
			id: 'waiting',
			label: 'Waiting on us',
			count: listedWaiting.value.length,
			counted: 'waiting for an answer',
			tone: overdue ? 'range' : 'stale-lock',
		},
		{
			id: 'pull-requests',
			label: 'Pull requests',
			count: pullCount,
			counted: 'open',
			tone: 'stale-lock',
		},
		{
			id: 'blocking',
			label: 'Blocking',
			count: listedBlocked.value,
			counted: 'blocked',
			tone: 'unknown',
		},
		{
			id: 'unreleased',
			label: 'Fixed, not released',
			count: unreleasedCount,
			counted:
				unreleasedCount === 1 ? 'fix waiting for a release' : 'fixes waiting for a release',
			tone: 'stale-lock',
		},
		{
			id: 'backlog',
			label: 'Backlog',
			count: listedTotal.value.issues,
			counted: 'open issues',
			tone: 'ahead',
		},
	];
});
const selected = ref(tabs.value[0]?.id ?? 'waiting');

const KIND: Record<OpenItem['kind'], string> = { issue: 'Issue', pull: 'Pull request' };

const HOW: Record<ClosedItem['how'], string> = {
	commit: 'by a commit',
	pull: 'by a pull request',
	merged: 'merged',
	manual: 'by hand',
};

const repoUrl = (repo: string): string => githubUrl(org, repo);
const search = (repo: string, q: string): string => searchUrl(org, repo, q);
</script>

<template>
	<div class="status-page">
		<h1>Issues and pull requests</h1>

		<p v-if="!data" class="notice">
			No snapshot in this build. Run <code>npm run sync:deps</code> to create one.
		</p>

		<template v-else>
			<SnapshotNote :generated-at="data.generatedAt" />

			<p v-if="issuesError" class="notice failed">
				The latest update could not read the issues. The next one tries again.
				<code>{{ issuesError }}</code>
			</p>

			<template v-if="report">
				<div class="filters">
					<label class="search">
						<span>Filter</span>
						<input v-model="query" type="search" placeholder="Repository or title" />
					</label>
				</div>

				<TabBar v-model="selected" :tabs="tabs" label="Parts of the issues page" />

				<section
					v-show="selected === 'waiting'"
					id="waiting-panel"
					role="tabpanel"
					aria-labelledby="waiting"
				>
					<p class="hint">
						Where someone outside had the last word. Nobody answered comes first, then whoever
						has waited longest. More than {{ WAIT_DAYS }} days is marked.
					</p>
					<div v-if="listedWaiting.length > 0" class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Waiting since</th>
									<th scope="col">Repository</th>
									<th scope="col">Issue or pull request</th>
									<th scope="col">From</th>
									<th scope="col">Replies</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="entry in listedWaiting" :key="entry.item.url">
									<td class="nowrap" :class="entry.overdue ? 'is-range' : 'is-stale-lock'">
										<span class="mark" aria-hidden="true">{{
											entry.overdue ? '✗' : '↑'
										}}</span>
										{{ when(entry.since) }}
										<span v-if="entry.overdue" class="visually-hidden">, too long</span>
									</td>
									<td class="nowrap">
										<a :href="repoUrl(entry.item.repo)">{{ entry.item.repo }}</a>
									</td>
									<td class="title">
										<span class="tag">{{ KIND[entry.item.kind] }}</span>
										<a :href="entry.item.url">{{ entry.item.title }}</a>
										<span class="dim"> #{{ entry.item.number }}</span>
									</td>
									<td class="nowrap">{{ entry.item.author ?? 'deleted account' }}</td>
									<td class="nowrap">
										<template v-if="entry.unanswered">
											<strong>No reply yet</strong>
										</template>
										<span v-else class="dim">
											{{ entry.item.comments }}, last by
											{{ entry.item.lastReply?.login ?? '?' }}
										</span>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-else class="empty">
						{{
							filtering
								? 'Nothing waiting matches the filter.'
								: 'Nobody is waiting for an answer.'
						}}
					</p>
				</section>

				<section
					v-show="selected === 'pull-requests'"
					id="pull-requests-panel"
					role="tabpanel"
					aria-labelledby="pull-requests"
				>
					<h2>From people</h2>
					<p class="hint">
						Stuck ones first, then those waiting for a review, then the rest, longest
						untouched first. A draft untouched for {{ STALE_DRAFT_DAYS }} days is marked as
						stale.
					</p>
					<div v-if="listedPulls.length > 0" class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Repository</th>
									<th scope="col">Pull request</th>
									<th scope="col">From</th>
									<th scope="col">State</th>
									<th scope="col">Updated</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="row in listedPulls" :key="row.item.url">
									<td class="nowrap">
										<a :href="repoUrl(row.item.repo)">{{ row.item.repo }}</a>
									</td>
									<td class="title">
										<a :href="row.item.url">{{ row.item.title }}</a>
										<span class="dim"> #{{ row.item.number }}</span>
									</td>
									<td class="nowrap">
										{{ row.item.author ?? 'deleted account' }}
										<span v-if="row.item.actor === 'outsider'" class="tag">outside</span>
									</td>
									<td>
										<ul class="states">
											<li
												v-for="problem in row.problems"
												:key="problem"
												class="is-range"
											>
												<span class="mark" aria-hidden="true">✗</span
												>{{ PROBLEMS[problem] }}
											</li>
											<li v-if="row.needsReview" class="is-stale-lock">
												<span class="mark" aria-hidden="true">↑</span>Waits for review
											</li>
											<li v-if="row.item.pull?.draft" class="is-ahead">
												<span class="mark" aria-hidden="true">»</span
												>{{ row.staleDraft ? 'Stale draft' : 'Draft' }}
											</li>
											<li v-if="row.item.pull?.review === 'approved'" class="is-current">
												<span class="mark" aria-hidden="true">✓</span>Approved
											</li>
										</ul>
									</td>
									<td class="nowrap dim">{{ when(row.item.updatedAt) }}</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-else class="empty">
						{{
							filtering
								? 'No pull request from people matches the filter.'
								: 'No open pull request from people.'
						}}
					</p>

					<h2>From bots</h2>
					<p class="hint">
						Grouped by what they update, so the same update can be handled in every repository
						at once.
					</p>
					<div v-if="listedBots.length > 0" class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Update</th>
									<th scope="col">Repositories</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="group in listedBots" :key="group.name">
									<td class="nowrap mono">{{ group.name }}</td>
									<td>
										<ul class="repos">
											<li v-for="entry in group.pulls" :key="entry.url">
												<a
													:href="entry.url"
													:class="`is-${CI_STATE[entry.pull?.ci ?? 'none'].tone}`"
													:title="entry.title"
												>
													<span
														v-if="entry.pull?.ci !== 'none'"
														class="mark"
														aria-hidden="true"
														>{{ CI_STATE[entry.pull?.ci ?? 'none'].mark }}</span
													>{{ entry.repo }}</a
												>
												<span class="visually-hidden">
													, CI {{ CI_STATE[entry.pull?.ci ?? 'none'].label }}</span
												>
												<span
													v-for="problem in entry.problems.filter(
														(p) => p !== 'failing',
													)"
													:key="problem"
													class="dim"
												>
													({{ PROBLEMS[problem] }})</span
												>
											</li>
										</ul>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-else class="empty">
						{{
							filtering
								? 'No pull request from bots matches the filter.'
								: 'No open pull request from bots.'
						}}
					</p>
				</section>

				<section
					v-show="selected === 'blocking'"
					id="blocking-panel"
					role="tabpanel"
					aria-labelledby="blocking"
				>
					<p class="hint">
						GitHub's “blocked by” links. Each issue at the top blocks the ones below it, so
						work from the top.
					</p>
					<ul v-if="listedTrees.length > 0" class="roots">
						<BlockTree
							v-for="tree in listedTrees"
							:key="`${tree.ref.repo}#${tree.ref.number}`"
							:node="tree"
							:org="org"
						/>
					</ul>
					<p v-else class="empty">
						{{
							filtering
								? 'No blocking issue matches the filter.'
								: 'No open issue blocks another.'
						}}
					</p>

					<template v-if="blocks.resolved.length > 0">
						<h2>Links to clean up</h2>
						<p class="hint">
							These still name blockers, but all of them are closed. Remove the links, or
							close the issue if the blocker solved it.
						</p>
						<ul class="plain">
							<li v-for="entry in listedResolved" :key="entry.item.url">
								<a class="mono" :href="entry.item.url"
									>{{ entry.item.repo }}#{{ entry.item.number }}</a
								>
								{{ entry.item.title }}
								<span class="dim">
									waited for
									<template
										v-for="(blocker, index) in entry.closed"
										:key="`${blocker.repo}#${blocker.number}`"
										><template v-if="index > 0">, </template
										><a class="mono" :href="refUrl(blocker)">{{
											shortRef(blocker, org)
										}}</a></template
									>
								</span>
							</li>
						</ul>
					</template>

					<template v-if="blocks.parents.length > 0">
						<h2>Sub-issues</h2>
						<p class="hint">Issues split into open sub-issues.</p>
						<ul class="plain">
							<li
								v-for="entry in listedParents"
								:key="`${entry.ref.repo}#${entry.ref.number}`"
							>
								<a class="mono" :href="entry.item?.url ?? refUrl(entry.ref)">{{
									shortRef(entry.ref, org)
								}}</a>
								{{ entry.item?.title ?? '' }}
								<ul>
									<li v-for="child in entry.children" :key="child.url">
										<a class="mono" :href="child.url"
											>{{ child.repo }}#{{ child.number }}</a
										>
										{{ child.title }}
									</li>
								</ul>
							</li>
						</ul>
					</template>
				</section>

				<section
					v-show="selected === 'unreleased'"
					id="unreleased-panel"
					role="tabpanel"
					aria-labelledby="unreleased"
				>
					<p class="hint">
						Issues closed as completed after their repository's latest release. Whoever
						reported them still waits for a release with the fix.
					</p>
					<p v-if="unreleased === null" class="notice failed">
						Unknown, because the latest update could not check the repositories and their
						releases.
					</p>
					<template v-else-if="listedUnreleased.length > 0">
						<div v-for="repo in listedUnreleased" :key="repo.repo" class="release">
							<p class="release-name">
								<a :href="repoUrl(repo.repo)">{{ repo.repo }}</a>
								<span class="dim">
									<a
										class="mono"
										:href="`${repoUrl(repo.repo)}/releases/tag/${repo.release.tag}`"
										>{{ repo.release.tag }}</a
									>
									{{ when(repo.release.date) }},
									<a
										:href="`${repoUrl(repo.repo)}/compare/${repo.release.tag}...${repo.branch}`"
										>{{ repo.commits }}
										{{ repo.commits === 1 ? 'commit' : 'commits' }} since</a
									>
								</span>
							</p>
							<ul class="plain">
								<li v-for="fix in repo.fixes" :key="fix.url">
									<a :href="fix.url">{{ fix.title }}</a>
									<span class="dim">
										#{{ fix.number }}, closed {{ when(fix.closedAt) }}
										{{ HOW[fix.how] }}</span
									>
								</li>
							</ul>
						</div>
					</template>
					<p v-else class="empty">
						{{ filtering ? 'No fix matches the filter.' : 'No fix waits for a release.' }}
					</p>
				</section>

				<section
					v-show="selected === 'backlog'"
					id="backlog-panel"
					role="tabpanel"
					aria-labelledby="backlog"
				>
					<p class="hint">
						Open issues per repository, the biggest backlog first. Each number opens the
						issues it counts on GitHub. Untouched for {{ STALE_ISSUE_DAYS }} days makes an
						issue a candidate to close.
					</p>
					<div v-if="listedBacklog.length > 0" class="scroll" tabindex="0">
						<table>
							<thead>
								<tr>
									<th scope="col">Repository</th>
									<th scope="col" class="count">Open</th>
									<th scope="col" class="count">Enhancement</th>
									<th scope="col" class="count">Bug</th>
									<th scope="col" class="count">No label</th>
									<th scope="col" class="count">Untouched</th>
									<th scope="col" class="count">Opened this week</th>
									<th scope="col" class="count">Closed this week</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="row in listedBacklog" :key="row.repo">
									<td class="nowrap">
										<a :href="repoUrl(row.repo)">{{ row.repo }}</a>
									</td>
									<td class="count" :class="{ dim: row.issues === 0 }">
										<a
											v-if="row.issues > 0"
											:href="search(row.repo, 'is:issue is:open')"
											>{{ row.issues }}</a
										>
										<template v-else>0</template>
									</td>
									<td class="count" :class="{ dim: row.enhancements === 0 }">
										<a
											v-if="row.enhancements > 0"
											:href="search(row.repo, 'is:issue is:open label:enhancement')"
											>{{ row.enhancements }}</a
										>
										<template v-else>0</template>
									</td>
									<td class="count" :class="{ dim: row.bugs === 0 }">
										<a
											v-if="row.bugs > 0"
											:href="search(row.repo, 'is:issue is:open label:bug')"
											>{{ row.bugs }}</a
										>
										<template v-else>0</template>
									</td>
									<td class="count" :class="{ dim: row.unlabelled === 0 }">
										<a
											v-if="row.unlabelled > 0"
											:href="search(row.repo, 'is:issue is:open no:label')"
											>{{ row.unlabelled }}</a
										>
										<template v-else>0</template>
									</td>
									<td class="count" :class="row.stale > 0 ? 'is-stale-lock' : 'dim'">
										<a
											v-if="row.stale > 0"
											:href="
												search(row.repo, `is:issue is:open updated:<${staleBefore}`)
											"
											>{{ row.stale }}</a
										>
										<template v-else>0</template>
									</td>
									<td class="count" :class="{ dim: row.openedThisWeek === 0 }">
										<a
											v-if="row.openedThisWeek > 0"
											:href="search(row.repo, `is:issue created:>=${weekAgo}`)"
											>{{ row.openedThisWeek }}</a
										>
										<template v-else>0</template>
									</td>
									<td class="count" :class="{ dim: row.closedThisWeek === 0 }">
										<a
											v-if="row.closedThisWeek > 0"
											:href="search(row.repo, `is:issue is:closed closed:>=${weekAgo}`)"
											>{{ row.closedThisWeek }}</a
										>
										<template v-else>0</template>
									</td>
								</tr>
							</tbody>
							<tfoot>
								<tr>
									<th scope="row">All</th>
									<td class="count">{{ listedTotal.issues }}</td>
									<td class="count">{{ listedTotal.enhancements }}</td>
									<td class="count">{{ listedTotal.bugs }}</td>
									<td class="count">{{ listedTotal.unlabelled }}</td>
									<td class="count">{{ listedTotal.stale }}</td>
									<td class="count">{{ listedTotal.openedThisWeek }}</td>
									<td class="count">{{ listedTotal.closedThisWeek }}</td>
								</tr>
							</tfoot>
						</table>
					</div>
					<p v-else class="empty">
						{{ filtering ? 'No repository matches the filter.' : 'No open issue anywhere.' }}
					</p>
				</section>
			</template>
		</template>
	</div>
</template>

<style scoped src="./status-shared.css"></style>
<style scoped src="./status-page.css"></style>

<style scoped>
h2 {
	margin: 24px 0 0;
	color: var(--vp-c-text-1);
	font-size: 16px;
	font-weight: 600;

	section > &:first-child {
		margin-top: 0;
	}
}

.tag {
	margin-right: 6px;
	padding: 0 5px;
	border: 1px solid var(--vp-c-divider);
	border-radius: 4px;
	color: var(--vp-c-text-2);
	font-size: 12px;
	white-space: nowrap;
}

td.is-range,
td.is-stale-lock {
	color: var(--st-color);
}

/* Wide enough that a narrow screen scrolls the table rather than squeeze the titles. */
.title {
	min-width: 240px;
}

/* Counts stand under their headings. */
.count {
	text-align: right;
}

tfoot th,
tfoot td {
	border-bottom: 0;
	font-weight: 600;
}

.states,
.repos,
.plain {
	margin: 0;
	padding: 0;
	list-style: none;
}

.states li {
	color: var(--st-color);
	white-space: nowrap;
}

.repos {
	display: flex;
	flex-wrap: wrap;
	gap: 2px 16px;

	a {
		color: var(--vp-c-brand-1);
	}

	.mark {
		color: var(--st-color);
	}
}

.plain {
	> li {
		padding: 4px 0;
	}

	ul {
		margin: 2px 0 0;
		padding-left: 22px;
		list-style: none;
	}
}

/* The roots of the blocking trees hang from nothing. */
.roots {
	margin: 0;
	padding: 0;
	list-style: none;

	> li::before,
	> li::after {
		content: none;
	}

	> li + li {
		margin-top: 8px;
	}
}

.release {
	margin-top: 12px;
}

.release-name {
	display: flex;
	flex-wrap: wrap;
	gap: 0 10px;
	align-items: baseline;
	margin: 0 0 4px;
	font-weight: 600;

	.dim {
		font-weight: 400;
	}
}
</style>
