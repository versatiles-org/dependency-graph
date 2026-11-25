import { describe, expect, it } from 'vitest';
import {
	actorOf,
	closedBatchQuery,
	collectIssues,
	parseClosed,
	parseOpen,
	type ApiClosedIssue,
	type ApiClosedPull,
	type ApiOpenIssue,
	type ApiOpenPull,
} from './issues';
import type { GraphQl, RepoStatus } from './repo-status';

const user = (login: string) => ({ login, __typename: 'User' });
const bot = (login: string) => ({ login, __typename: 'Bot' });

const openIssue = (overrides: Partial<ApiOpenIssue> = {}): ApiOpenIssue => ({
	__typename: 'Issue',
	number: 1,
	title: 'Something breaks',
	url: 'https://github.com/org/a/issues/1',
	repository: { name: 'a' },
	author: user('someone'),
	authorAssociation: 'NONE',
	createdAt: '2026-11-01T00:00:00Z',
	updatedAt: '2026-11-02T00:00:00Z',
	labels: { nodes: [] },
	comments: { totalCount: 0, nodes: [] },
	blockedBy: { nodes: [] },
	parent: null,
	...overrides,
});

const openPull = (overrides: Partial<ApiOpenPull> = {}): ApiOpenPull => ({
	__typename: 'PullRequest',
	number: 2,
	title: 'Fix it',
	url: 'https://github.com/org/a/pull/2',
	repository: { name: 'a' },
	author: user('someone'),
	authorAssociation: 'CONTRIBUTOR',
	createdAt: '2026-11-01T00:00:00Z',
	updatedAt: '2026-11-02T00:00:00Z',
	isDraft: false,
	mergeable: 'MERGEABLE',
	reviewDecision: null,
	labels: { nodes: [] },
	comments: { totalCount: 0, nodes: [] },
	reviews: { nodes: [] },
	commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
	...overrides,
});

const closedIssue = (closer: string | null, overrides: Partial<ApiClosedIssue> = {}) =>
	({
		__typename: 'Issue',
		number: 3,
		title: 'Fixed',
		url: 'https://github.com/org/a/issues/3',
		repository: { name: 'a' },
		closedAt: '2026-11-20T00:00:00Z',
		timelineItems: { nodes: [{ closer: closer ? { __typename: closer } : null }] },
		...overrides,
	}) satisfies ApiClosedIssue;

const closedPull = (merged: boolean): ApiClosedPull => ({
	__typename: 'PullRequest',
	number: 4,
	title: 'Done',
	url: 'https://github.com/org/a/pull/4',
	repository: { name: 'a' },
	closedAt: '2026-11-20T00:00:00Z',
	merged,
});

describe('actorOf', () => {
	it('tells maintainers, outsiders and bots apart', () => {
		expect(actorOf(user('m'), 'OWNER')).toBe('maintainer');
		expect(actorOf(user('m'), 'MEMBER')).toBe('maintainer');
		expect(actorOf(user('m'), 'COLLABORATOR')).toBe('maintainer');
		expect(actorOf(user('o'), 'CONTRIBUTOR')).toBe('outsider');
		expect(actorOf(user('o'), 'FIRST_TIME_CONTRIBUTOR')).toBe('outsider');
		expect(actorOf(user('o'), 'NONE')).toBe('outsider');
		expect(actorOf(bot('dependabot'), 'NONE')).toBe('bot');
		expect(actorOf(null, 'NONE')).toBe('outsider');
	});
});

describe('parseOpen', () => {
	it('reads an issue with its labels, last reply, blockers and parent', () => {
		const parsed = parseOpen(
			openIssue({
				labels: { nodes: [{ name: 'bug' }, null] },
				comments: {
					totalCount: 2,
					nodes: [
						{
							author: user('m'),
							authorAssociation: 'MEMBER',
							createdAt: '2026-11-03T00:00:00Z',
						},
					],
				},
				blockedBy: {
					nodes: [
						{ number: 7, state: 'OPEN', repository: { nameWithOwner: 'org/b' } },
						{ number: 8, state: 'CLOSED', repository: { nameWithOwner: 'org/a' } },
						null,
					],
				},
				parent: { number: 9, repository: { nameWithOwner: 'org/a' } },
			}),
		);
		expect(parsed).toEqual({
			repo: 'a',
			number: 1,
			kind: 'issue',
			title: 'Something breaks',
			url: 'https://github.com/org/a/issues/1',
			author: 'someone',
			actor: 'outsider',
			createdAt: '2026-11-01T00:00:00Z',
			updatedAt: '2026-11-02T00:00:00Z',
			labels: ['bug'],
			comments: 2,
			lastReply: { login: 'm', actor: 'maintainer', at: '2026-11-03T00:00:00Z' },
			pull: null,
			blockedBy: [
				{ repo: 'org/b', number: 7, open: true },
				{ repo: 'org/a', number: 8, open: false },
			],
			parent: { repo: 'org/a', number: 9 },
		});
	});

	it('has no reply for an issue nobody answered, and copes with a deleted author', () => {
		const parsed = parseOpen(openIssue({ author: null }));
		expect(parsed).toMatchObject({ author: null, actor: 'outsider', lastReply: null });
	});

	it('reads the state of a pull request', () => {
		const parsed = parseOpen(
			openPull({ isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' }),
		);
		expect(parsed).toMatchObject({
			kind: 'pull',
			blockedBy: [],
			parent: null,
			pull: { draft: true, conflicts: true, review: 'changes', ci: 'passing' },
		});

		expect(parseOpen(openPull({ mergeable: 'UNKNOWN' })).pull?.conflicts).toBeNull();
		expect(parseOpen(openPull({ reviewDecision: 'APPROVED' })).pull?.review).toBe('approved');
		expect(parseOpen(openPull({ reviewDecision: 'REVIEW_REQUIRED' })).pull?.review).toBe(
			'required',
		);
		expect(parseOpen(openPull({ commits: { nodes: [] } })).pull?.ci).toBe('none');
	});

	it('takes a review as a reply when it is newer than the last comment', () => {
		const comment = {
			author: user('o'),
			authorAssociation: 'NONE',
			createdAt: '2026-11-03T00:00:00Z',
		};
		const review = {
			author: user('m'),
			authorAssociation: 'MEMBER',
			submittedAt: '2026-11-04T00:00:00Z',
		};
		const withBoth = openPull({
			comments: { totalCount: 1, nodes: [comment] },
			reviews: { nodes: [review] },
		});
		expect(parseOpen(withBoth).lastReply).toEqual({
			login: 'm',
			actor: 'maintainer',
			at: '2026-11-04T00:00:00Z',
		});

		// A review not yet submitted has no date, and nobody has seen it.
		const pending = openPull({
			comments: { totalCount: 1, nodes: [comment] },
			reviews: { nodes: [{ ...review, submittedAt: null }] },
		});
		expect(parseOpen(pending).lastReply?.login).toBe('o');
	});
});

describe('parseClosed', () => {
	it('says what closed an issue, and whether a pull request was merged', () => {
		expect(parseClosed(closedIssue('Commit')).how).toBe('commit');
		expect(parseClosed(closedIssue('PullRequest')).how).toBe('pull');
		expect(parseClosed(closedIssue(null)).how).toBe('manual');
		expect(parseClosed(closedIssue(null, { timelineItems: { nodes: [] } })).how).toBe('manual');
		expect(parseClosed(closedPull(true))).toMatchObject({ kind: 'pull', how: 'merged' });
		expect(parseClosed(closedPull(false)).how).toBe('manual');
	});
});

describe('collectIssues', () => {
	const now = new Date('2026-11-25T12:00:00Z');

	const repo = (name: string, overrides: Partial<RepoStatus> = {}): RepoStatus => ({
		name,
		branch: 'main',
		issues: 0,
		pulls: 0,
		botPulls: 0,
		ci: 'passing',
		lastCommit: null,
		release: { tag: 'v1.0.0', date: '2026-10-01T00:00:00Z' },
		unreleased: 3,
		trivyIgnore: null,
		...overrides,
	});

	/**
	 * Answers each search from the pages given for it, and records what was asked
	 * and how many requests it took. A batch of searches, each under an alias,
	 * gets the first page of each.
	 */
	const fake = (answers: Record<string, { nodes: unknown[]; count?: number }[]>) => {
		const asked: string[] = [];
		let requests = 0;
		const page = (q: string, index: number) => {
			const key = Object.keys(answers).find((part) => q.includes(part));
			const pages = key ? answers[key] : [{ nodes: [] }];
			const { nodes, count } = pages[index];
			const hasNextPage = index + 1 < pages.length;
			return {
				issueCount: count ?? nodes.length,
				pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null },
				nodes,
			};
		};
		const query = ((text: string, variables?: Record<string, unknown>) => {
			requests += 1;
			if (!variables) {
				const batch: Record<string, unknown> = {};
				for (const [, alias, quoted] of text.matchAll(
					/(r\d+): search\(query: ("(?:[^"\\]|\\.)*")/g,
				)) {
					const q = JSON.parse(quoted) as string;
					asked.push(q);
					batch[alias] = page(q, 0);
				}
				return Promise.resolve(batch);
			}
			const q = String(variables.q);
			asked.push(q);
			return Promise.resolve({ search: page(q, variables.after ? Number(variables.after) : 0) });
		}) as GraphQl;
		return { query, asked, requests: () => requests };
	};

	it('keeps the covered repositories, follows the pages and skips what is not an item', async () => {
		const { query } = fake({
			'is:open': [
				{ nodes: [openIssue(), {}, null] },
				{ nodes: [openPull({ repository: { name: 'private' } }), openPull()] },
			],
			'closed:>=': [
				{
					nodes: [
						closedPull(true),
						closedIssue('Commit', { repository: { name: 'private' } }),
					],
				},
			],
		});
		const report = await collectIssues(query, 'org', new Set(['a']), { now, repos: null });
		expect(report.open.map((item) => [item.kind, item.number])).toEqual([
			['issue', 1],
			['pull', 2],
		]);
		expect(report.closed.map((item) => item.number)).toEqual([4]);
		expect(report.unreleased).toBeNull();
	});

	it('asks for what was closed in the last seven days', async () => {
		const { query, asked } = fake({});
		await collectIssues(query, 'org', new Set(), { now, repos: null });
		expect(asked).toEqual([
			'org:org is:open archived:false sort:created-asc',
			'org:org closed:>=2026-11-18T12:00:00.000Z sort:updated-desc',
		]);
	});

	it('looks for fixes since the release only where commits followed it', async () => {
		const { query, asked } = fake({ 'repo:org/a ': [{ nodes: [closedIssue('Commit')] }] });
		const report = await collectIssues(query, 'org', new Set(['a', 'b', 'c', 'd']), {
			now,
			repos: [
				repo('a'),
				repo('b', { unreleased: 0 }),
				repo('c', { release: null, unreleased: null }),
				repo('d', { unreleased: null }),
				repo('uncovered'),
			],
		});
		expect(asked.filter((q) => q.startsWith('repo:'))).toEqual([
			'repo:org/a is:issue is:closed reason:completed closed:>2026-10-01T00:00:00Z sort:updated-desc',
		]);
		expect(report.unreleased).toEqual([
			expect.objectContaining({ repo: 'a', number: 3, how: 'commit' }),
		]);
	});

	it('asks for the fixes of every repository in one request', async () => {
		const { query, requests } = fake({
			'repo:org/a ': [{ nodes: [closedIssue('Commit')] }],
			'repo:org/b ': [
				{ nodes: [closedIssue('PullRequest', { number: 5, repository: { name: 'b' } })] },
			],
		});
		const report = await collectIssues(query, 'org', new Set(['a', 'b']), {
			now,
			repos: [repo('a'), repo('b')],
		});
		// Open, closed this week, and one for all the fixes.
		expect(requests()).toBe(3);
		expect(report.unreleased?.map((fix) => [fix.repo, fix.number, fix.how])).toEqual([
			['a', 3, 'commit'],
			['b', 5, 'pull'],
		]);
	});

	it('follows the pages of a repository with more fixes than one answer holds', async () => {
		const { query, requests } = fake({
			'repo:org/a ': [
				{ nodes: [closedIssue('Commit', { number: 1 })] },
				{ nodes: [closedIssue('Commit', { number: 2 })] },
			],
		});
		const report = await collectIssues(query, 'org', new Set(['a']), { now, repos: [repo('a')] });
		expect(report.unreleased?.map((fix) => fix.number)).toEqual([1, 2]);
		// The batch, then both pages of that one search again.
		expect(requests()).toBe(5);
	});

	it('fails rather than list fixes that GitHub cuts short', async () => {
		const { query } = fake({ 'repo:org/a ': [{ nodes: [], count: 1001 }] });
		await expect(
			collectIssues(query, 'org', new Set(['a']), { now, repos: [repo('a')] }),
		).rejects.toThrow('more than it can list');
	});

	it('fails rather than list a search that GitHub cuts short', async () => {
		const { query } = fake({ 'is:open': [{ nodes: [], count: 1001 }] });
		await expect(collectIssues(query, 'org', new Set(), { now, repos: null })).rejects.toThrow(
			'more than it can list',
		);
	});
});

describe('closedBatchQuery', () => {
	it('puts each search under an alias, with its text quoted', () => {
		const text = closedBatchQuery(['repo:org/a is:closed', 'say "hi"']);
		expect(text).toContain('r0: search(query: "repo:org/a is:closed", type: ISSUE, first: 100)');
		expect(text).toContain('r1: search(query: "say \\"hi\\"", type: ISSUE, first: 100)');
	});
});
