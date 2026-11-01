import { describe, expect, it } from 'vitest';
import {
	ciState,
	collectRepoStatus,
	parseRepo,
	unreleasedQuery,
	type ApiRepo,
	type GraphQl,
} from './repo-status';

const api = (name: string, overrides: Partial<ApiRepo> = {}): ApiRepo => ({
	name,
	issues: { totalCount: 3 },
	pullRequests: { totalCount: 0, nodes: [] },
	latestRelease: null,
	defaultBranchRef: {
		name: 'main',
		target: { committedDate: '2026-10-28T00:00:00Z', statusCheckRollup: { state: 'SUCCESS' } },
	},
	...overrides,
});

describe('ciState', () => {
	it('reduces what GitHub reports to what matters here', () => {
		expect(ciState('SUCCESS')).toBe('passing');
		expect(ciState('FAILURE')).toBe('failing');
		expect(ciState('ERROR')).toBe('failing');
		expect(ciState('PENDING')).toBe('running');
		expect(ciState('EXPECTED')).toBe('running');
		expect(ciState(null)).toBe('none');
		expect(ciState(undefined)).toBe('none');
	});
});

describe('parseRepo', () => {
	it('reads what is open, the branch and the release', () => {
		const parsed = parseRepo(
			api('a', {
				latestRelease: { tagName: 'v1.0.0', publishedAt: '2026-10-01T00:00:00Z' },
			}),
		);
		expect(parsed).toEqual({
			name: 'a',
			branch: 'main',
			issues: 3,
			pulls: 0,
			botPulls: 0,
			ci: 'passing',
			lastCommit: '2026-10-28T00:00:00Z',
			release: { tag: 'v1.0.0', date: '2026-10-01T00:00:00Z' },
			unreleased: null,
		});
	});

	it('counts the pull requests from bots, and copes with a deleted author', () => {
		const parsed = parseRepo(
			api('a', {
				pullRequests: {
					totalCount: 4,
					nodes: [
						{ author: { __typename: 'Bot' } },
						{ author: { __typename: 'User' } },
						{ author: null },
						null,
					],
				},
			}),
		);
		expect(parsed).toMatchObject({ pulls: 4, botPulls: 1 });
	});

	it('copes with an empty repository, and a branch without checks', () => {
		expect(parseRepo(api('a', { defaultBranchRef: null }))).toMatchObject({
			branch: null,
			ci: 'none',
			lastCommit: null,
		});
		const unchecked = api('b', {
			defaultBranchRef: { name: 'main', target: { statusCheckRollup: null } },
		});
		expect(parseRepo(unchecked).ci).toBe('none');
	});
});

describe('unreleasedQuery', () => {
	it('asks for each repository under an alias, with its names quoted', () => {
		const query = unreleasedQuery('org', [
			{ ...parseRepo(api('a')), release: { tag: 'v1"x', date: '' } },
		]);
		expect(query).toContain('r0: repository(owner: "org", name: "a")');
		expect(query).toContain('qualifiedName: "refs/tags/v1\\"x"');
		expect(query).toContain('compare(headRef: "main")');
	});
});

describe('collectRepoStatus', () => {
	const released = { tagName: 'v1.0.0', publishedAt: '2026-10-01T00:00:00Z' };

	/** Answers the status query from pages, and anything else from one answer. */
	const fake = (pages: { nodes: ApiRepo[]; next?: string }[], unreleased = {}) => {
		const calls: { query: string; variables?: Record<string, unknown> }[] = [];
		const query = ((text: string, variables?: Record<string, unknown>) => {
			calls.push({ query: text, variables });
			if (!text.includes('organization')) return Promise.resolve(unreleased);
			const index = variables?.after ? Number(variables.after) : 0;
			const { nodes, next } = pages[index];
			return Promise.resolve({
				organization: {
					repositories: {
						nodes,
						pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
					},
				},
			});
		}) as GraphQl;
		return { query, calls };
	};

	it('leaves out repositories the status does not cover', async () => {
		const { query } = fake([{ nodes: [api('a'), api('excluded')] }]);
		const repos = await collectRepoStatus(query, 'org', new Set(['a']));
		expect(repos.map((repo) => repo.name)).toEqual(['a']);
	});

	it('follows the pages', async () => {
		const { query, calls } = fake([{ nodes: [api('a')], next: '1' }, { nodes: [api('b')] }]);
		const repos = await collectRepoStatus(query, 'org', new Set(['a', 'b']));
		expect(repos.map((repo) => repo.name)).toEqual(['a', 'b']);
		expect(calls.map((call) => call.variables?.after)).toEqual([null, '1']);
	});

	it('counts the commits since a release, and only asks when there are releases', async () => {
		const { query, calls } = fake(
			[
				{
					nodes: [
						api('a', { latestRelease: released }),
						api('b'),
						api('c', { latestRelease: released }),
					],
				},
			],
			{ r0: { ref: { compare: { aheadBy: 7 } } }, r1: { ref: null } },
		);
		const repos = await collectRepoStatus(query, 'org', new Set(['a', 'b', 'c']));
		expect(repos.map((repo) => [repo.name, repo.unreleased])).toEqual([
			['a', 7],
			['b', null],
			['c', null],
		]);
		expect(calls).toHaveLength(2);

		const none = fake([{ nodes: [api('b')] }]);
		await collectRepoStatus(none.query, 'org', new Set(['b']));
		expect(none.calls).toHaveLength(1);
	});

	it('passes a failure on, for the snapshot to record', async () => {
		const query = (() => Promise.reject(new Error('502'))) as GraphQl;
		await expect(collectRepoStatus(query, 'org', new Set())).rejects.toThrow('502');
	});
});
