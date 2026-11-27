/**
 * What the issues page does with a snapshot: who waits for an answer, which
 * pull requests are stuck, what blocks what, and how each repository's backlog
 * looks. It runs in the browser, so like `status-view.ts` it may only import
 * types.
 *
 * Every rule that depends on time is measured against the snapshot's own time,
 * so the page says the same whether it is built or read later.
 */

import type { ClosedItem, IssueRef, OpenItem } from './issues';
import type { RepoImportance } from './model';
import type { RepoStatus } from './repo-status';

const DAY = 24 * 3_600_000;

/** After this long without an answer, someone has waited too long. */
export const WAIT_DAYS = 7;
/** A draft nobody touched for this long is probably forgotten. */
export const STALE_DRAFT_DAYS = 30;
/** An issue nobody touched for this long is a candidate to close. */
export const STALE_ISSUE_DAYS = 180;

const olderThan = (date: string, days: number, now: Date): boolean =>
	now.getTime() - new Date(date).getTime() > days * DAY;

/** The day `days` before `now`, as GitHub's search wants it. */
export function dayBefore(now: Date, days: number): string {
	return new Date(now.getTime() - days * DAY).toISOString().slice(0, 10);
}

/** An issue written as GitHub does across repositories: `owner/name#1`. */
export function refText(ref: IssueRef): string {
	return `${ref.repo}#${ref.number}`;
}

export function refUrl(ref: IssueRef): string {
	return `https://github.com/${ref.repo}/issues/${ref.number}`;
}

/** Shortened inside the organisation, where the owner goes without saying. */
export function shortRef(ref: IssueRef, org: string): string {
	return ref.repo.startsWith(`${org}/`)
		? `${ref.repo.slice(org.length + 1)}#${ref.number}`
		: refText(ref);
}

/** Matches the filter on the repository or the title, ignoring case. */
export function matches(item: { repo: string; title: string }, query: string): boolean {
	const needle = query.trim().toLowerCase();
	return (
		needle === '' ||
		item.repo.toLowerCase().includes(needle) ||
		item.title.toLowerCase().includes(needle)
	);
}

/** A search for issues and pull requests of one repository on GitHub. */
export function searchUrl(org: string, repo: string, q: string): string {
	return `https://github.com/${org}/${repo}/issues?q=${encodeURIComponent(q)}`;
}

// Waiting on us --------------------------------------------------------------

export interface Waiting {
	item: OpenItem;
	/** Since when the last word, by someone outside, has had no answer. */
	since: string;
	/** Nobody has replied at all. */
	unanswered: boolean;
	overdue: boolean;
}

/**
 * Everything where someone outside had the last word. A bot's comment answers
 * nobody, so it counts as no reply. Nobody answered at all comes first, then
 * whoever has waited longest.
 */
export function waitingOnUs(open: OpenItem[], now: Date): Waiting[] {
	const found: Waiting[] = [];
	for (const item of open) {
		const reply = item.lastReply?.actor === 'bot' ? null : item.lastReply;
		const lastWord = reply ? reply.actor : item.actor;
		if (lastWord !== 'outsider') continue;
		const since = reply?.at ?? item.createdAt;
		found.push({
			item,
			since,
			unanswered: item.lastReply === null,
			overdue: olderThan(since, WAIT_DAYS, now),
		});
	}
	return found.sort(
		(a, b) => Number(b.unanswered) - Number(a.unanswered) || a.since.localeCompare(b.since),
	);
}

// Pull requests ---------------------------------------------------------------

export type Problem = 'conflicts' | 'failing' | 'changes';

export const PROBLEMS: Record<Problem, string> = {
	conflicts: 'Conflicts',
	failing: 'CI failing',
	changes: 'Changes requested',
};

export interface PullRow {
	item: OpenItem;
	problems: Problem[];
	/** From someone outside and not a draft, so it waits for a review. */
	needsReview: boolean;
	staleDraft: boolean;
}

export function problemsOf(item: OpenItem): Problem[] {
	const pull = item.pull;
	if (!pull) return [];
	const problems: Problem[] = [];
	if (pull.conflicts) problems.push('conflicts');
	if (pull.ci === 'failing') problems.push('failing');
	if (pull.review === 'changes') problems.push('changes');
	return problems;
}

/**
 * The pull requests people opened: stuck ones first, then those waiting for a
 * review, then the rest, each longest untouched first.
 */
export function humanPulls(open: OpenItem[], now: Date): PullRow[] {
	const rank = (row: PullRow) => (row.problems.length > 0 ? 0 : row.needsReview ? 1 : 2);
	return open
		.filter((item) => item.kind === 'pull' && item.actor !== 'bot')
		.map((item) => ({
			item,
			problems: problemsOf(item),
			needsReview:
				item.actor === 'outsider' && !item.pull?.draft && item.pull?.review !== 'approved',
			staleDraft: Boolean(item.pull?.draft) && olderThan(item.updatedAt, STALE_DRAFT_DAYS, now),
		}))
		.sort((a, b) => rank(a) - rank(b) || a.item.updatedAt.localeCompare(b.item.updatedAt));
}

/**
 * What a bot's pull request updates, from its title, so the same update in
 * several repositories can be handled together. Dependabot and Renovate name it
 * after a conventional-commit prefix, if any:
 *
 *   bump vite from 8.3.2 to 8.3.4 in the security group  →  vite
 *   bump the npm group across 1 directory with 7 updates  →  npm group
 *   update dependency vite to v8                          →  vite
 */
export function updateName(title: string): string {
	const text = title.replace(/^[\w-]+(\([^)]*\))?!?:\s*/, '');
	const group = /^bump the (\S+) group\b/i.exec(text);
	if (group) return `${group[1]} group`;
	const bump = /^bump (\S+) from /i.exec(text);
	if (bump) return bump[1];
	const update =
		/^update (?:dependency |rust crate |module |docker tag )?(\S+)(?: digest)? to /i.exec(text);
	if (update) return update[1];
	return text;
}

export interface BotGroup {
	name: string;
	pulls: (OpenItem & { problems: Problem[] })[];
}

/** The bots' pull requests by what they update; the widest updates first. */
export function botGroups(open: OpenItem[]): BotGroup[] {
	const groups = new Map<string, BotGroup>();
	for (const item of open) {
		if (item.kind !== 'pull' || item.actor !== 'bot') continue;
		const name = updateName(item.title);
		const group = groups.get(name) ?? { name, pulls: [] };
		group.pulls.push({ ...item, problems: problemsOf(item) });
		groups.set(name, group);
	}
	return [...groups.values()]
		.map((group) => ({
			...group,
			pulls: group.pulls.sort((a, b) => a.repo.localeCompare(b.repo)),
		}))
		.sort((a, b) => b.pulls.length - a.pulls.length || a.name.localeCompare(b.name));
}

// Blocking --------------------------------------------------------------------

export interface BlockNode {
	ref: IssueRef;
	/** Null for an issue the snapshot doesn't have: closed, or outside the organisation. */
	item: OpenItem | null;
	/** The open issues that wait for this one. */
	blocks: BlockNode[];
	/** Other open issues the same issue waits for, shown where it appears. */
	alsoWaitsFor: IssueRef[];
	/** Already shown higher up, in a cycle of issues waiting for each other. */
	cycle: boolean;
}

export interface Blocking {
	/** One tree per issue that blocks others and waits for nothing open itself. */
	trees: BlockNode[];
	/** Open issues that only wait for closed ones: the links can go. */
	resolved: { item: OpenItem; closed: IssueRef[] }[];
	/** Issues with their open sub-issues. */
	parents: { ref: IssueRef; item: OpenItem | null; children: OpenItem[] }[];
}

export function blocking(org: string, open: OpenItem[]): Blocking {
	const key = (ref: IssueRef) => refText(ref);
	const refOf = (item: OpenItem): IssueRef => ({
		repo: `${org}/${item.repo}`,
		number: item.number,
	});
	const issues = open.filter((item) => item.kind === 'issue');
	const byKey = new Map(issues.map((item) => [key(refOf(item)), item]));

	/** Blocker → the open issues waiting for it, for open blockers only. */
	const waiting = new Map<string, OpenItem[]>();
	const openBlockers = new Map<string, IssueRef[]>();
	const resolved: Blocking['resolved'] = [];
	for (const item of issues) {
		const live = item.blockedBy.filter((blocker) => blocker.open);
		if (item.blockedBy.length > 0 && live.length === 0) {
			resolved.push({
				item,
				closed: item.blockedBy.map(({ repo, number }) => ({ repo, number })),
			});
		}
		const refs = live.map(({ repo, number }) => ({ repo, number }));
		if (refs.length > 0) openBlockers.set(key(refOf(item)), refs);
		for (const blocker of refs) {
			const list = waiting.get(key(blocker)) ?? [];
			list.push(item);
			waiting.set(key(blocker), list);
		}
	}

	const build = (ref: IssueRef, parent: IssueRef | null, path: Set<string>): BlockNode => {
		const id = key(ref);
		const cycle = path.has(id);
		const next = new Set(path).add(id);
		return {
			ref,
			item: byKey.get(id) ?? null,
			blocks: cycle ? [] : (waiting.get(id) ?? []).map((item) => build(refOf(item), ref, next)),
			alsoWaitsFor: (openBlockers.get(id) ?? []).filter(
				(other) => parent === null || key(other) !== key(parent),
			),
			cycle,
		};
	};

	// A root blocks something and waits for nothing open. Where every issue waits
	// for another, in a cycle, the first of them stands in as the root.
	const roots = [...waiting.keys()].filter((id) => !openBlockers.has(id));
	if (roots.length === 0 && waiting.size > 0) roots.push([...waiting.keys()][0]);
	const trees = roots.sort().map((id) => {
		const [repo, number] = id.split('#');
		return build({ repo, number: Number(number) }, null, new Set());
	});

	const parents = new Map<string, Blocking['parents'][number]>();
	for (const item of issues) {
		if (!item.parent) continue;
		const id = key(item.parent);
		const entry = parents.get(id) ?? {
			ref: item.parent,
			item: byKey.get(id) ?? null,
			children: [],
		};
		entry.children.push(item);
		parents.set(id, entry);
	}

	return {
		trees,
		resolved,
		parents: [...parents.values()].sort((a, b) => key(a.ref).localeCompare(key(b.ref))),
	};
}

// Fixed, not released ---------------------------------------------------------

export interface UnreleasedRepo {
	repo: string;
	release: { tag: string; date: string };
	branch: string;
	/** Commits on the default branch since the release. */
	commits: number;
	fixes: ClosedItem[];
}

/** The fixes waiting for a release, by repository, the oldest fix first. */
export function unreleasedByRepo(fixes: ClosedItem[], repos: RepoStatus[]): UnreleasedRepo[] {
	const found: UnreleasedRepo[] = [];
	for (const repo of repos) {
		const own = fixes
			.filter((fix) => fix.repo === repo.name)
			.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
		if (own.length === 0 || !repo.release || !repo.branch) continue;
		found.push({
			repo: repo.name,
			release: repo.release,
			branch: repo.branch,
			commits: repo.unreleased ?? 0,
			fixes: own,
		});
	}
	return found.sort(
		(a, b) =>
			a.fixes[0].closedAt.localeCompare(b.fixes[0].closedAt) || a.repo.localeCompare(b.repo),
	);
}

// Open issues -----------------------------------------------------------------

export interface IssueRow {
	item: OpenItem;
	/** How many open issues wait for this one. */
	blocks: number;
	/** How many open issues this one waits for. */
	waitsFor: number;
	/** How many open sub-issues it has. */
	subIssues: number;
	/** Touched within the last `WAIT_DAYS`. */
	active: boolean;
	/** Untouched for longer than `STALE_ISSUE_DAYS`. */
	stale: boolean;
}

export interface IssueGroup {
	repo: string;
	/** Null for a repository the dependency graph doesn't know. */
	category: string | null;
	usedBy: number;
	issues: IssueRow[];
}

/**
 * Every open issue, by repository, in the order of `importance`; repositories
 * it doesn't know follow by name. In each repository the issues that block
 * others come first, the most blocking first, then the most recently touched.
 */
export function openIssues(
	org: string,
	open: OpenItem[],
	importance: RepoImportance[],
	now: Date,
): IssueGroup[] {
	const issues = open.filter((item) => item.kind === 'issue');
	const keyOf = (item: OpenItem) => `${org}/${item.repo}#${item.number}`;
	const blocks = new Map<string, number>();
	const subIssues = new Map<string, number>();
	const add = (counts: Map<string, number>, key: string) =>
		counts.set(key, (counts.get(key) ?? 0) + 1);
	for (const item of issues) {
		for (const blocker of item.blockedBy) if (blocker.open) add(blocks, refText(blocker));
		if (item.parent) add(subIssues, refText(item.parent));
	}

	const known = new Map(importance.map((repo, index) => [repo.name, { repo, index }]));
	const groups = new Map<string, IssueGroup>();
	for (const item of issues) {
		const info = known.get(item.repo)?.repo;
		const group = groups.get(item.repo) ?? {
			repo: item.repo,
			category: info?.category ?? null,
			usedBy: info?.usedBy ?? 0,
			issues: [],
		};
		group.issues.push({
			item,
			blocks: blocks.get(keyOf(item)) ?? 0,
			waitsFor: item.blockedBy.filter((blocker) => blocker.open).length,
			subIssues: subIssues.get(keyOf(item)) ?? 0,
			active: !olderThan(item.updatedAt, WAIT_DAYS, now),
			stale: olderThan(item.updatedAt, STALE_ISSUE_DAYS, now),
		});
		groups.set(item.repo, group);
	}

	const place = (repo: string) => known.get(repo)?.index ?? importance.length;
	for (const group of groups.values()) {
		group.issues.sort(
			(a, b) => b.blocks - a.blocks || b.item.updatedAt.localeCompare(a.item.updatedAt),
		);
	}
	return [...groups.values()].sort(
		(a, b) => place(a.repo) - place(b.repo) || a.repo.localeCompare(b.repo),
	);
}

// Next up ---------------------------------------------------------------------

/** How soon a step wants doing. */
export type Urgency = 'now' | 'soon' | 'later';

export interface NextStep {
	urgency: Urgency;
	/** Why it is a step, in a few words. */
	reason: string;
	/** Where it is: one repository, or each one an update reaches. */
	repos: string[];
	title: string;
	url: string;
	number: number | null;
	/** Since when it has waited, where that matters. */
	since: string | null;
	/** The tab with the details. */
	tab: 'waiting' | 'pull-requests' | 'blocking' | 'unreleased';
}

const plural = (count: number, one: string, many: string): string =>
	`${count} ${count === 1 ? one : many}`;

/** Every issue below a blocker in its tree, each once. */
function blockedBelow(node: BlockNode, seen = new Set<string>()): Set<string> {
	for (const child of node.blocks) {
		seen.add(refText(child.ref));
		blockedBelow(child, seen);
	}
	return seen;
}

/**
 * What to do next, from what the other tabs list, in this order:
 *
 * - now: someone outside waited longer than `WAIT_DAYS`, or a pull request
 *   from people is stuck;
 * - soon: someone outside waits, a pull request from outside waits for a
 *   review, or an open issue blocks others, the most blocking first;
 * - later: fixes have waited longer than `WAIT_DAYS` for a release, bots'
 *   updates fail or are ready to merge, or links to closed blockers can go.
 *
 * Within each kind the order of its tab holds.
 */
export function nextSteps(
	org: string,
	lists: {
		waiting: Waiting[];
		pulls: PullRow[];
		bots: BotGroup[];
		blocks: Blocking;
		unreleased: UnreleasedRepo[] | null;
	},
	now: Date,
): NextStep[] {
	const { waiting, pulls, bots, blocks, unreleased } = lists;
	const ofItem = (item: OpenItem) => ({
		repos: [item.repo],
		title: item.title,
		url: item.url,
		number: item.number,
	});
	const answer = (entry: Waiting, urgency: Urgency): NextStep => ({
		urgency,
		reason: entry.unanswered ? 'No reply yet' : 'Waits for an answer',
		...ofItem(entry.item),
		since: entry.since,
		tab: 'waiting',
	});

	const stuck = pulls
		.filter((row) => row.problems.length > 0)
		.map((row): NextStep => ({
			urgency: 'now',
			reason: row.problems.map((problem) => PROBLEMS[problem]).join(', '),
			...ofItem(row.item),
			since: row.item.updatedAt,
			tab: 'pull-requests',
		}));
	const reviews = pulls
		.filter((row) => row.problems.length === 0 && row.needsReview)
		.map((row): NextStep => ({
			urgency: 'soon',
			reason: 'Waits for a review',
			...ofItem(row.item),
			since: row.item.createdAt,
			tab: 'pull-requests',
		}));

	// A blocker outside the snapshot is closed or elsewhere, so nothing to do here.
	const blockers = blocks.trees
		.flatMap((tree) => (tree.item ? [{ item: tree.item, count: blockedBelow(tree).size }] : []))
		.sort((a, b) => b.count - a.count)
		.map(({ item, count }): NextStep => ({
			urgency: 'soon',
			reason: `Blocks ${plural(count, 'issue', 'issues')}`,
			...ofItem(item),
			since: null,
			tab: 'blocking',
		}));

	const releases = (unreleased ?? [])
		.filter((repo) => olderThan(repo.fixes[0].closedAt, WAIT_DAYS, now))
		.map((repo): NextStep => ({
			urgency: 'later',
			reason: 'Fixed, not released',
			repos: [repo.repo],
			title: `${plural(repo.fixes.length, 'fix', 'fixes')} since ${repo.release.tag}`,
			url: `https://github.com/${org}/${repo.repo}/compare/${repo.release.tag}...${repo.branch}`,
			number: null,
			since: repo.fixes[0].closedAt,
			tab: 'unreleased',
		}));

	const update = (group: BotGroup, reason: string): NextStep => ({
		urgency: 'later',
		reason,
		repos: group.pulls.map((entry) => entry.repo),
		title: `Update ${group.name}`,
		url: group.pulls[0].url,
		number: group.pulls.length === 1 ? group.pulls[0].number : null,
		since: null,
		tab: 'pull-requests',
	});
	const broken = (group: BotGroup) => group.pulls.some((entry) => entry.problems.length > 0);
	const ready = (group: BotGroup) =>
		group.pulls.every((entry) => entry.problems.length === 0 && entry.pull?.ci === 'passing');
	const failingUpdates = bots
		.filter(broken)
		.map((group) =>
			update(
				group,
				[
					...new Set(
						group.pulls.flatMap((entry) =>
							entry.problems.map((problem) => PROBLEMS[problem]),
						),
					),
				].join(', '),
			),
		);
	const readyUpdates = bots.filter(ready).map((group) => update(group, 'Ready to merge'));

	const cleanup: NextStep[] =
		blocks.resolved.length === 0
			? []
			: [
					{
						urgency: 'later',
						reason: 'Links to clean up',
						repos: [...new Set(blocks.resolved.map((entry) => entry.item.repo))],
						title: `${plural(blocks.resolved.length, 'issue waits', 'issues wait')} only for closed issues`,
						url: blocks.resolved[0].item.url,
						number: null,
						since: null,
						tab: 'blocking',
					},
				];

	// A pull request from outside nobody answered also waits for a review: it is listed once, where it ranks highest.
	const seen = new Set<string>();
	return [
		...waiting.filter((entry) => entry.overdue).map((entry) => answer(entry, 'now')),
		...stuck,
		...waiting.filter((entry) => !entry.overdue).map((entry) => answer(entry, 'soon')),
		...reviews,
		...blockers,
		...releases,
		...failingUpdates,
		...readyUpdates,
		...cleanup,
	].filter((step) => {
		if (step.number === null) return true;
		const key = `${step.repos[0]}#${step.number}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// Backlog ---------------------------------------------------------------------

export interface BacklogRow {
	repo: string;
	issues: number;
	enhancements: number;
	bugs: number;
	unlabelled: number;
	/** Untouched for longer than `STALE_ISSUE_DAYS`. */
	stale: number;
	openedThisWeek: number;
	closedThisWeek: number;
}

const hasLabel = (item: OpenItem, names: string[]): boolean =>
	item.labels.some((label) => names.includes(label.toLowerCase()));

/** One row per repository with open issues or a closed one this week, the biggest backlog first. */
export function backlog(open: OpenItem[], closed: ClosedItem[], now: Date): BacklogRow[] {
	const rows = new Map<string, BacklogRow>();
	const row = (repo: string): BacklogRow => {
		let found = rows.get(repo);
		if (!found) {
			found = {
				repo,
				issues: 0,
				enhancements: 0,
				bugs: 0,
				unlabelled: 0,
				stale: 0,
				openedThisWeek: 0,
				closedThisWeek: 0,
			};
			rows.set(repo, found);
		}
		return found;
	};
	for (const item of open) {
		if (item.kind !== 'issue') continue;
		const entry = row(item.repo);
		entry.issues += 1;
		if (hasLabel(item, ['enhancement', 'feature'])) entry.enhancements += 1;
		if (hasLabel(item, ['bug'])) entry.bugs += 1;
		if (item.labels.length === 0) entry.unlabelled += 1;
		if (olderThan(item.updatedAt, STALE_ISSUE_DAYS, now)) entry.stale += 1;
		if (!olderThan(item.createdAt, WAIT_DAYS, now)) entry.openedThisWeek += 1;
	}
	for (const item of closed) {
		if (item.kind === 'issue') row(item.repo).closedThisWeek += 1;
	}
	return [...rows.values()].sort((a, b) => b.issues - a.issues || a.repo.localeCompare(b.repo));
}

/** The whole organisation in one row, for the foot of the table. */
export function backlogTotal(rows: BacklogRow[]): Omit<BacklogRow, 'repo'> {
	const total = {
		issues: 0,
		enhancements: 0,
		bugs: 0,
		unlabelled: 0,
		stale: 0,
		openedThisWeek: 0,
		closedThisWeek: 0,
	};
	for (const row of rows) {
		for (const field of Object.keys(total) as (keyof typeof total)[]) total[field] += row[field];
	}
	return total;
}
