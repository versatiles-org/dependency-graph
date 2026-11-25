/**
 * The issues and pull requests of all repositories, for the status page: who is
 * waiting for an answer, which pull requests are stuck, which issues block
 * others, what was closed this week, and which fixes are not released yet.
 *
 * GitHub's search finds them across the organisation in a few pages, where
 * asking each repository would take dozens of queries. It finds everything the
 * token can read, so the results are narrowed to the repositories the status
 * covers.
 */

import { ciState, type CiState, type GraphQl, type RepoStatus } from './repo-status';

/** Who wrote something: someone with write access, anyone else, or a bot. */
export type Actor = 'maintainer' | 'outsider' | 'bot';

export interface Reply {
	login: string | null;
	actor: Actor;
	at: string;
}

/** An issue anywhere on GitHub, its repository written as `owner/name`. */
export interface IssueRef {
	repo: string;
	number: number;
}

export interface PullState {
	draft: boolean;
	/** Whether it conflicts with its base branch, or null while GitHub hasn't worked it out. */
	conflicts: boolean | null;
	review: 'approved' | 'changes' | 'required' | null;
	ci: CiState;
}

export interface OpenItem {
	repo: string;
	number: number;
	kind: 'issue' | 'pull';
	title: string;
	url: string;
	/** Null for a deleted account. */
	author: string | null;
	actor: Actor;
	createdAt: string;
	updatedAt: string;
	labels: string[];
	comments: number;
	/** The newest comment, or review of a pull request, from anyone. */
	lastReply: Reply | null;
	/** Only for pull requests. */
	pull: PullState | null;
	/** The issues this one waits for, open or not. Always empty for pull requests. */
	blockedBy: (IssueRef & { open: boolean })[];
	/** The issue this one is a sub-issue of. */
	parent: IssueRef | null;
}

export interface ClosedItem {
	repo: string;
	number: number;
	kind: 'issue' | 'pull';
	title: string;
	url: string;
	closedAt: string;
	/** For an issue: what closed it. For a pull request: whether it was merged. */
	how: 'commit' | 'pull' | 'merged' | 'manual';
}

export interface IssueReport {
	open: OpenItem[];
	/** Issues and pull requests closed in the seven days before the snapshot. */
	closed: ClosedItem[];
	/**
	 * Issues closed as completed after their repository's latest release, in the
	 * repositories with commits since that release. Null when the releases are not
	 * known, because the repositories could not be checked.
	 */
	unreleased: ClosedItem[] | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** GitHub's search answers no more than this many results for one query. */
const SEARCH_LIMIT = 1000;

const AUTHOR = 'author { login __typename } authorAssociation';

const OPEN_FIELDS = `
  __typename
  ... on Issue {
    number title url createdAt updatedAt ${AUTHOR}
    repository { name }
    labels(first: 20) { nodes { name } }
    comments(last: 1) { totalCount nodes { createdAt ${AUTHOR} } }
    blockedBy(first: 20) { nodes { number state repository { nameWithOwner } } }
    parent { number repository { nameWithOwner } }
  }
  ... on PullRequest {
    number title url createdAt updatedAt ${AUTHOR} isDraft mergeable reviewDecision
    repository { name }
    labels(first: 20) { nodes { name } }
    comments(last: 1) { totalCount nodes { createdAt ${AUTHOR} } }
    reviews(last: 1) { nodes { submittedAt ${AUTHOR} } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`;

const CLOSED_FIELDS = `
  __typename
  ... on Issue {
    number title url closedAt
    repository { name }
    timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { closer { __typename } } } }
  }
  ... on PullRequest {
    number title url closedAt merged
    repository { name }
  }`;

const searchQuery = (fields: string) => `query ($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${fields} }
  }
}`;

export const OPEN_QUERY = searchQuery(OPEN_FIELDS);
export const CLOSED_QUERY = searchQuery(CLOSED_FIELDS);

type ApiAuthor = { login: string; __typename: string } | null;

interface ApiReply {
	author: ApiAuthor;
	authorAssociation: string;
}

interface ApiCommon {
	number: number;
	title: string;
	url: string;
	repository: { name: string };
}

export interface ApiOpenIssue extends ApiCommon, ApiReply {
	__typename: 'Issue';
	createdAt: string;
	updatedAt: string;
	labels: { nodes: ({ name: string } | null)[] };
	comments: { totalCount: number; nodes: ((ApiReply & { createdAt: string }) | null)[] };
	blockedBy: {
		nodes: ({ number: number; state: string; repository: { nameWithOwner: string } } | null)[];
	};
	parent: { number: number; repository: { nameWithOwner: string } } | null;
}

export interface ApiOpenPull extends ApiCommon, ApiReply {
	__typename: 'PullRequest';
	createdAt: string;
	updatedAt: string;
	isDraft: boolean;
	mergeable: string;
	reviewDecision: string | null;
	labels: { nodes: ({ name: string } | null)[] };
	comments: { totalCount: number; nodes: ((ApiReply & { createdAt: string }) | null)[] };
	reviews: { nodes: ((ApiReply & { submittedAt: string | null }) | null)[] };
	commits: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] };
}

export interface ApiClosedIssue extends ApiCommon {
	__typename: 'Issue';
	closedAt: string;
	timelineItems: { nodes: ({ closer?: { __typename: string } | null } | null)[] };
}

export interface ApiClosedPull extends ApiCommon {
	__typename: 'PullRequest';
	closedAt: string;
	merged: boolean;
}

/** Search can answer other kinds of node, and an empty one for what the token may not read. */
type ApiNode<T> = T | { __typename?: string } | null;

interface SearchPage<T> {
	search: {
		issueCount: number;
		pageInfo: { hasNextPage: boolean; endCursor: string | null };
		nodes: ApiNode<T>[];
	};
}

const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function actorOf(author: ApiAuthor, association: string): Actor {
	if (author?.__typename === 'Bot') return 'bot';
	return MAINTAINERS.has(association) ? 'maintainer' : 'outsider';
}

function reply(node: ApiReply, at: string | null): Reply | null {
	if (!at) return null;
	return {
		login: node.author?.login ?? null,
		actor: actorOf(node.author, node.authorAssociation),
		at,
	};
}

/** The newest of the given replies; ISO dates in UTC sort as text. */
function newest(replies: (Reply | null)[]): Reply | null {
	let found: Reply | null = null;
	for (const candidate of replies) {
		if (candidate && (!found || candidate.at > found.at)) found = candidate;
	}
	return found;
}

const REVIEWS: Record<string, PullState['review']> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes',
	REVIEW_REQUIRED: 'required',
};

export function parseOpen(node: ApiOpenIssue | ApiOpenPull): OpenItem {
	const lastComment = node.comments.nodes.at(-1);
	const replies = [lastComment ? reply(lastComment, lastComment.createdAt) : null];
	let pull: PullState | null = null;
	if (node.__typename === 'PullRequest') {
		const lastReview = node.reviews.nodes.at(-1);
		replies.push(lastReview ? reply(lastReview, lastReview.submittedAt) : null);
		pull = {
			draft: node.isDraft,
			conflicts:
				node.mergeable === 'CONFLICTING' ? true : node.mergeable === 'MERGEABLE' ? false : null,
			review: REVIEWS[node.reviewDecision ?? ''] ?? null,
			ci: ciState(node.commits.nodes.at(-1)?.commit.statusCheckRollup?.state),
		};
	}
	const issue = node.__typename === 'Issue' ? node : null;
	return {
		repo: node.repository.name,
		number: node.number,
		kind: issue ? 'issue' : 'pull',
		title: node.title,
		url: node.url,
		author: node.author?.login ?? null,
		actor: actorOf(node.author, node.authorAssociation),
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
		labels: node.labels.nodes.flatMap((label) => (label ? [label.name] : [])),
		comments: node.comments.totalCount,
		lastReply: newest(replies),
		pull,
		blockedBy: (issue?.blockedBy.nodes ?? []).flatMap((blocker) =>
			blocker
				? [
						{
							repo: blocker.repository.nameWithOwner,
							number: blocker.number,
							open: blocker.state === 'OPEN',
						},
					]
				: [],
		),
		parent: issue?.parent
			? { repo: issue.parent.repository.nameWithOwner, number: issue.parent.number }
			: null,
	};
}

export function parseClosed(node: ApiClosedIssue | ApiClosedPull): ClosedItem {
	let how: ClosedItem['how'];
	if (node.__typename === 'PullRequest') {
		how = node.merged ? 'merged' : 'manual';
	} else {
		const closer = node.timelineItems.nodes.at(-1)?.closer?.__typename;
		how = closer === 'Commit' ? 'commit' : closer === 'PullRequest' ? 'pull' : 'manual';
	}
	return {
		repo: node.repository.name,
		number: node.number,
		kind: node.__typename === 'Issue' ? 'issue' : 'pull',
		title: node.title,
		url: node.url,
		closedAt: node.closedAt,
		how,
	};
}

function isItem<T extends { __typename: string }>(node: ApiNode<T>): node is T {
	return node?.__typename === 'Issue' || node?.__typename === 'PullRequest';
}

/** Every result of one search, in the order GitHub gives them. */
async function searchAll<T extends { __typename: string }>(
	query: GraphQl,
	text: string,
	q: string,
): Promise<T[]> {
	const found: T[] = [];
	let after: string | null = null;
	for (;;) {
		const page: SearchPage<T> = await query<SearchPage<T>>(text, { q, after });
		const { issueCount, nodes, pageInfo } = page.search;
		// Past the limit, search drops results without saying which.
		if (issueCount > SEARCH_LIMIT) {
			throw new Error(`search found ${issueCount} results, more than it can list: ${q}`);
		}
		found.push(...nodes.filter(isItem));
		if (!pageInfo.hasNextPage) return found;
		after = pageInfo.endCursor;
	}
}

/** When the repository's latest release was published, if commits have followed it. */
function releasedSince(repo: RepoStatus): string | null {
	if (!repo.release?.date || !repo.unreleased) return null;
	return repo.release.date;
}

export async function collectIssues(
	query: GraphQl,
	org: string,
	names: Set<string>,
	{ now, repos }: { now: Date; repos: RepoStatus[] | null },
): Promise<IssueReport> {
	const covered = (node: { repository: { name: string } }) => names.has(node.repository.name);

	const open = await searchAll<ApiOpenIssue | ApiOpenPull>(
		query,
		OPEN_QUERY,
		`org:${org} is:open archived:false sort:created-asc`,
	);

	const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString();
	const closed = await searchAll<ApiClosedIssue | ApiClosedPull>(
		query,
		CLOSED_QUERY,
		`org:${org} closed:>=${weekAgo} sort:updated-desc`,
	);

	let unreleased: ClosedItem[] | null = null;
	if (repos) {
		unreleased = [];
		for (const repo of repos) {
			const since = releasedSince(repo);
			if (!since || !names.has(repo.name)) continue;
			const fixed = await searchAll<ApiClosedIssue | ApiClosedPull>(
				query,
				CLOSED_QUERY,
				`repo:${org}/${repo.name} is:issue is:closed reason:completed closed:>${since} sort:updated-desc`,
			);
			unreleased.push(...fixed.map(parseClosed));
		}
	}

	return {
		open: open.filter(covered).map(parseOpen),
		closed: closed.filter(covered).map(parseClosed),
		unreleased,
	};
}
