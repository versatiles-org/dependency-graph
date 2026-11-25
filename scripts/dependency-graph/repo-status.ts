/**
 * The state of each repository, for the status page: what is open, whether its
 * default branch passes, and what is waiting to be released.
 *
 * All of it comes from two GraphQL queries, however many repositories there are.
 * The second one needs the release tags that the first one returns.
 */

export type CiState = 'passing' | 'failing' | 'running' | 'none';

export interface RepoStatus {
	name: string;
	/** Default branch, or null for an empty repository. */
	branch: string | null;
	issues: number;
	pulls: number;
	/** Open pull requests from bots such as Dependabot, included in `pulls`. */
	botPulls: number;
	ci: CiState;
	/** When the newest commit on the default branch was made. */
	lastCommit: string | null;
	release: { tag: string; date: string } | null;
	/** Commits on the default branch since the latest release, when that can be told. */
	unreleased: number | null;
	/** The findings Trivy is told to ignore, or null without a `.trivyignore` file. */
	trivyIgnore: TrivyIgnore[] | null;
}

/** An accepted finding in `.trivyignore`, with the day Trivy reports it again. */
export interface TrivyIgnore {
	id: string;
	/** `exp:YYYY-MM-DD` of the entry, or null if it never expires. */
	expires: string | null;
}

export type GraphQl = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const STATUS_QUERY = `query ($org: String!, $after: String) {
  organization(login: $org) {
    repositories(first: 100, after: $after, privacy: PUBLIC, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN, first: 100) {
          totalCount
          nodes { author { __typename } }
        }
        latestRelease { tagName publishedAt }
        defaultBranchRef {
          name
          target { ... on Commit { committedDate statusCheckRollup { state } } }
        }
        trivyIgnore: object(expression: "HEAD:.trivyignore") { ... on Blob { text } }
      }
    }
  }
}`;

export interface ApiRepo {
	name: string;
	issues: { totalCount: number };
	pullRequests: {
		totalCount: number;
		nodes: ({ author: { __typename: string } | null } | null)[];
	};
	latestRelease: { tagName: string; publishedAt: string | null } | null;
	defaultBranchRef: {
		name: string;
		target: { committedDate?: string; statusCheckRollup?: { state: string } | null } | null;
	} | null;
	/** Absent in answers from before the field was asked for. */
	trivyIgnore?: { text?: string | null } | null;
}

interface StatusPage {
	organization: {
		repositories: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
			nodes: ApiRepo[];
		};
	};
}

/** Only a pending check means "not decided yet"; a check that expects a result counts as that too. */
export function ciState(state: string | null | undefined): CiState {
	switch (state) {
		case 'SUCCESS':
			return 'passing';
		case 'FAILURE':
		case 'ERROR':
			return 'failing';
		case 'PENDING':
		case 'EXPECTED':
			return 'running';
		default:
			return 'none';
	}
}

/**
 * Reads Trivy's plain ignore format: one finding per line, optionally followed
 * by `exp:YYYY-MM-DD`, and `#` starting a comment.
 */
export function parseTrivyIgnore(text: string): TrivyIgnore[] {
	const entries: TrivyIgnore[] = [];
	for (const line of text.split('\n')) {
		const [id, ...options] = line.replace(/#.*/, '').trim().split(/\s+/);
		if (!id) continue;
		const expires = options.find((option) => /^exp:\d{4}-\d{2}-\d{2}$/.test(option));
		entries.push({ id, expires: expires ? expires.slice(4) : null });
	}
	return entries;
}

export function parseRepo(repo: ApiRepo): RepoStatus {
	const target = repo.defaultBranchRef?.target;
	return {
		name: repo.name,
		branch: repo.defaultBranchRef?.name ?? null,
		issues: repo.issues.totalCount,
		pulls: repo.pullRequests.totalCount,
		botPulls: repo.pullRequests.nodes.filter((pull) => pull?.author?.__typename === 'Bot').length,
		ci: ciState(target?.statusCheckRollup?.state),
		lastCommit: target?.committedDate ?? null,
		release: repo.latestRelease
			? { tag: repo.latestRelease.tagName, date: repo.latestRelease.publishedAt ?? '' }
			: null,
		unreleased: null,
		trivyIgnore:
			typeof repo.trivyIgnore?.text === 'string'
				? parseTrivyIgnore(repo.trivyIgnore.text)
				: null,
	};
}

/** One query for many repositories, each under an alias of its place in the list. */
export function unreleasedQuery(org: string, repos: RepoStatus[]): string {
	const lines = repos.map((repo, index) => {
		const ref = JSON.stringify(`refs/tags/${repo.release?.tag}`);
		return (
			`  r${index}: repository(owner: ${JSON.stringify(org)}, name: ${JSON.stringify(repo.name)}) ` +
			`{ ref(qualifiedName: ${ref}) { compare(headRef: ${JSON.stringify(repo.branch)}) { aheadBy } } }`
		);
	});
	return `query {\n${lines.join('\n')}\n}`;
}

export async function collectRepoStatus(
	query: GraphQl,
	org: string,
	names: Set<string>,
): Promise<RepoStatus[]> {
	const repos: RepoStatus[] = [];
	let after: string | null = null;
	for (;;) {
		const page: StatusPage = await query<StatusPage>(STATUS_QUERY, { org, after });
		const { nodes, pageInfo } = page.organization.repositories;
		repos.push(...nodes.filter((repo) => names.has(repo.name)).map(parseRepo));
		if (!pageInfo.hasNextPage) break;
		after = pageInfo.endCursor;
	}

	const released = repos.filter((repo) => repo.release && repo.branch);
	if (released.length > 0) {
		const answers = await query<
			Record<string, { ref: { compare: { aheadBy: number } | null } | null }>
		>(unreleasedQuery(org, released));
		released.forEach((repo, index) => {
			repo.unreleased = answers[`r${index}`]?.ref?.compare?.aheadBy ?? null;
		});
	}
	return repos;
}
