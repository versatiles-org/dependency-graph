import { describe, expect, it } from 'vitest';
import type { ClosedItem, OpenItem } from './issues';
import {
	backlog,
	backlogTotal,
	blocking,
	botGroups,
	dayBefore,
	humanPulls,
	matches,
	searchUrl,
	shortRef,
	unreleasedByRepo,
	updateName,
	waitingOnUs,
} from './issues-view';
import type { RepoStatus } from './repo-status';

const now = new Date('2026-11-25T12:00:00Z');

const item = (overrides: Partial<OpenItem> = {}): OpenItem => ({
	repo: 'a',
	number: 1,
	kind: 'issue',
	title: 'Something',
	url: 'https://github.com/org/a/issues/1',
	author: 'someone',
	actor: 'outsider',
	createdAt: '2026-11-01T00:00:00Z',
	updatedAt: '2026-11-01T00:00:00Z',
	labels: [],
	comments: 0,
	lastReply: null,
	pull: null,
	blockedBy: [],
	parent: null,
	...overrides,
});

const pull = (overrides: Partial<OpenItem> = {}, state: Partial<OpenItem['pull']> = {}) =>
	item({
		kind: 'pull',
		pull: { draft: false, conflicts: false, review: null, ci: 'passing', ...state },
		...overrides,
	});

const closed = (overrides: Partial<ClosedItem> = {}): ClosedItem => ({
	repo: 'a',
	number: 9,
	kind: 'issue',
	title: 'Fixed',
	url: 'https://github.com/org/a/issues/9',
	closedAt: '2026-11-20T00:00:00Z',
	how: 'commit',
	...overrides,
});

describe('helpers', () => {
	it('shortens references inside the organisation only', () => {
		expect(shortRef({ repo: 'org/a', number: 3 }, 'org')).toBe('a#3');
		expect(shortRef({ repo: 'other/a', number: 3 }, 'org')).toBe('other/a#3');
	});

	it('filters on the repository or the title, ignoring case', () => {
		const entry = { repo: 'versatiles-rs', title: 'Serve PMTiles' };
		expect(matches(entry, '')).toBe(true);
		expect(matches(entry, ' RS ')).toBe(true);
		expect(matches(entry, 'pmtiles')).toBe(true);
		expect(matches(entry, 'style')).toBe(false);
	});

	it('builds searches on GitHub and the days they need', () => {
		expect(dayBefore(now, 7)).toBe('2026-11-18');
		expect(searchUrl('org', 'a', 'is:issue no:label')).toBe(
			'https://github.com/org/a/issues?q=is%3Aissue%20no%3Alabel',
		);
	});
});

describe('waitingOnUs', () => {
	it('lists where someone outside had the last word, unanswered first, then longest waiting', () => {
		const list = waitingOnUs(
			[
				item({ number: 1, createdAt: '2026-11-20T00:00:00Z' }),
				item({
					number: 2,
					createdAt: '2026-10-01T00:00:00Z',
					lastReply: { login: 'o', actor: 'outsider', at: '2026-11-10T00:00:00Z' },
				}),
				item({
					number: 3,
					lastReply: { login: 'm', actor: 'maintainer', at: '2026-11-02T00:00:00Z' },
				}),
				item({
					number: 4,
					actor: 'maintainer',
					lastReply: { login: 'o', actor: 'outsider', at: '2026-11-24T00:00:00Z' },
				}),
				item({ number: 5, actor: 'maintainer' }),
				pull({ number: 6, actor: 'bot' }),
			],
			now,
		);
		expect(
			list.map((entry) => [entry.item.number, entry.since, entry.unanswered, entry.overdue]),
		).toEqual([
			[1, '2026-11-20T00:00:00Z', true, false],
			[2, '2026-11-10T00:00:00Z', false, true],
			[4, '2026-11-24T00:00:00Z', false, false],
		]);
	});

	it('takes a bot comment as no answer', () => {
		const list = waitingOnUs(
			[item({ lastReply: { login: 'ci', actor: 'bot', at: '2026-11-24T00:00:00Z' } })],
			now,
		);
		expect(list).toMatchObject([
			{ since: '2026-11-01T00:00:00Z', unanswered: false, overdue: true },
		]);
	});
});

describe('humanPulls', () => {
	it('puts stuck pull requests first, then those waiting for review, and leaves out bots', () => {
		const rows = humanPulls(
			[
				pull({ number: 1, actor: 'maintainer', updatedAt: '2026-11-20T00:00:00Z' }),
				pull({ number: 2 }, { ci: 'failing', conflicts: true }),
				pull({ number: 3 }),
				pull({ number: 4, actor: 'bot' }, { ci: 'failing' }),
				pull({ number: 5 }, { review: 'approved' }),
				pull({ number: 6, actor: 'maintainer' }, { draft: true }),
				pull({ number: 7 }, { draft: true, review: 'changes' }),
				item({ number: 8 }),
			],
			now,
		);
		expect(
			rows.map((row) => [row.item.number, row.problems, row.needsReview, row.staleDraft]),
		).toEqual([
			[2, ['conflicts', 'failing'], true, false],
			[7, ['changes'], false, false],
			[3, [], true, false],
			[5, [], false, false],
			[6, [], false, false],
			[1, [], false, false],
		]);
	});

	it('marks drafts nobody touched for a month', () => {
		const [row] = humanPulls([pull({ updatedAt: '2026-10-01T00:00:00Z' }, { draft: true })], now);
		expect(row.staleDraft).toBe(true);
	});
});

describe('updateName', () => {
	it('reads what a bot updates from its title', () => {
		for (const [title, name] of [
			[
				'build(deps): bump dtolnay/rust-toolchain from 1.85 to 1.120 in the github-action group',
				'dtolnay/rust-toolchain',
			],
			[
				'chore(deps-dev): bump vite from 8.3.2 to 8.3.4 in the security group across 1 directory',
				'vite',
			],
			['chore(deps): bump the npm group across 1 directory with 23 updates', 'npm group'],
			['Bump the maven-minor group with 6 updates', 'maven-minor group'],
			['chore(deps): update dependency vite to v8', 'vite'],
			['Update rust crate serde to 1.0.200', 'serde'],
			['Update actions/checkout digest to abc123', 'actions/checkout'],
			['Something else', 'Something else'],
		]) {
			expect(updateName(title)).toBe(name);
		}
	});
});

describe('botGroups', () => {
	it('groups the same update across repositories, the widest first', () => {
		const groups = botGroups([
			pull({ repo: 'b', actor: 'bot', title: 'chore(deps): bump the npm group with 7 updates' }),
			pull({
				repo: 'c',
				actor: 'bot',
				title: 'build(deps): bump certbot/certbot from v5 to v6',
			}),
			pull(
				{ repo: 'a', actor: 'bot', title: 'build(deps): bump the npm group with 23 updates' },
				{ ci: 'failing' },
			),
			pull({ repo: 'a', title: 'bump the npm group by hand' }),
		]);
		expect(
			groups.map((group) => [
				group.name,
				group.pulls.map((entry) => [entry.repo, entry.problems]),
			]),
		).toEqual([
			[
				'npm group',
				[
					['a', ['failing']],
					['b', []],
				],
			],
			['certbot/certbot', [['c', []]]],
		]);
	});
});

describe('blocking', () => {
	const blocked = (
		number: number,
		by: [string, number, boolean][],
		overrides: Partial<OpenItem> = {},
	) =>
		item({
			number,
			blockedBy: by.map(([repo, n, open]) => ({ repo, number: n, open })),
			...overrides,
		});

	it('draws trees from the issues that wait for nothing open', () => {
		const result = blocking('org', [
			item({ number: 1 }),
			blocked(2, [['org/a', 1, true]]),
			blocked(3, [
				['org/a', 2, true],
				['org/b', 5, true],
			]),
			blocked(4, [['org/a', 1, true]]),
		]);
		const shape = (node: (typeof result.trees)[number]): unknown => [
			`${node.ref.repo}#${node.ref.number}`,
			node.alsoWaitsFor.map((ref) => `${ref.repo}#${ref.number}`),
			node.blocks.map(shape),
		];
		// org/b#5 is not in the snapshot, but blocks something open, so it is a root of its own.
		expect(result.trees.map(shape)).toEqual([
			[
				'org/a#1',
				[],
				[
					['org/a#2', [], [['org/a#3', ['org/b#5'], []]]],
					['org/a#4', [], []],
				],
			],
			['org/b#5', [], [['org/a#3', ['org/a#2'], []]]],
		]);
		expect(result.trees[0].item?.number).toBe(1);
		expect(result.trees[1].item).toBeNull();
	});

	it('lists issues that only wait for closed ones, and ignores pull requests', () => {
		const result = blocking('org', [
			blocked(2, [
				['org/a', 1, false],
				['org/b', 3, false],
			]),
			blocked(4, [
				['org/a', 1, false],
				['org/a', 5, true],
			]),
			item({ number: 5 }),
		]);
		expect(result.resolved.map((entry) => [entry.item.number, entry.closed.length])).toEqual([
			[2, 2],
		]);
		expect(result.trees.map((tree) => tree.ref.number)).toEqual([5]);
	});

	it('stops at a cycle', () => {
		const result = blocking('org', [
			blocked(1, [['org/a', 2, true]]),
			blocked(2, [['org/a', 1, true]]),
		]);
		expect(result.trees).toHaveLength(1);
		const [root] = result.trees;
		expect(root.blocks[0].blocks[0]).toMatchObject({ cycle: true, blocks: [] });
	});

	it('groups sub-issues under their parent', () => {
		const result = blocking('org', [
			item({ number: 1, title: 'Epic' }),
			item({ number: 2, parent: { repo: 'org/a', number: 1 } }),
			item({ number: 3, parent: { repo: 'org/a', number: 1 } }),
			item({ number: 4, parent: { repo: 'org/b', number: 7 } }),
		]);
		expect(
			result.parents.map((entry) => [
				entry.item?.title ?? null,
				entry.children.map((c) => c.number),
			]),
		).toEqual([
			['Epic', [2, 3]],
			[null, [4]],
		]);
	});
});

describe('unreleasedByRepo', () => {
	const repo = (name: string, overrides: Partial<RepoStatus> = {}): RepoStatus => ({
		name,
		branch: 'main',
		issues: 0,
		pulls: 0,
		botPulls: 0,
		ci: 'passing',
		lastCommit: null,
		release: { tag: 'v1.0.0', date: '2026-10-01T00:00:00Z' },
		unreleased: 4,
		...overrides,
	});

	it('groups the fixes by repository, the longest waiting first', () => {
		const groups = unreleasedByRepo(
			[
				closed({ repo: 'b', number: 2, closedAt: '2026-11-10T00:00:00Z' }),
				closed({ repo: 'a', number: 3, closedAt: '2026-11-20T00:00:00Z' }),
				closed({ repo: 'b', number: 1, closedAt: '2026-11-01T00:00:00Z' }),
			],
			[repo('a'), repo('b'), repo('c')],
		);
		expect(
			groups.map((group) => [group.repo, group.commits, group.fixes.map((fix) => fix.number)]),
		).toEqual([
			['b', 4, [1, 2]],
			['a', 4, [3]],
		]);
	});
});

describe('backlog', () => {
	it('counts each repository, the biggest backlog first, with a total', () => {
		const rows = backlog(
			[
				item({ repo: 'a', labels: ['Bug'] }),
				item({ repo: 'a', labels: ['enhancement'], updatedAt: '2026-01-01T00:00:00Z' }),
				item({ repo: 'b', createdAt: '2026-11-24T00:00:00Z' }),
				pull({ repo: 'b' }),
			],
			[closed({ repo: 'c' }), closed({ repo: 'b', kind: 'pull' })],
			now,
		);
		expect(rows).toEqual([
			{
				repo: 'a',
				issues: 2,
				enhancements: 1,
				bugs: 1,
				unlabelled: 0,
				stale: 1,
				openedThisWeek: 0,
				closedThisWeek: 0,
			},
			{
				repo: 'b',
				issues: 1,
				enhancements: 0,
				bugs: 0,
				unlabelled: 1,
				stale: 0,
				openedThisWeek: 1,
				closedThisWeek: 0,
			},
			{
				repo: 'c',
				issues: 0,
				enhancements: 0,
				bugs: 0,
				unlabelled: 0,
				stale: 0,
				openedThisWeek: 0,
				closedThisWeek: 1,
			},
		]);
		expect(backlogTotal(rows)).toEqual({
			issues: 3,
			enhancements: 1,
			bugs: 1,
			unlabelled: 1,
			stale: 1,
			openedThisWeek: 1,
			closedThisWeek: 1,
		});
	});
});
