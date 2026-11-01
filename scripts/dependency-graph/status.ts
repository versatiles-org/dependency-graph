/**
 * The snapshot behind the status page.
 *
 * Unlike the graph, it is not committed: versions move with every release, and
 * a commit for each of them would only bury the changes worth reviewing. Each
 * run writes it next to the build, and each deploy publishes it.
 *
 * Every section can fail on its own. A registry being down says nothing about
 * the dependency graph or about the other sections, so a failure is recorded in
 * the snapshot, where the page can show it, and goes no further.
 */

import { buildDriftReport, type DriftReport, type DriftResult } from './drift';
import type { RepoStatus } from './repo-status';

export type StatusSection<T> = { status: 'ok'; data: T } | { status: 'failed'; error: string };

export interface StatusSnapshot {
	/** The GitHub organisation the repository names belong to. */
	org: string;
	/** When the data was collected, as an ISO date. */
	generatedAt: string;
	drift: StatusSection<DriftReport>;
	repos: StatusSection<RepoStatus[]>;
}

async function section<T>(collect: () => Promise<T>): Promise<StatusSection<T>> {
	try {
		return { status: 'ok', data: await collect() };
	} catch (error) {
		return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
	}
}

export async function buildStatusSnapshot(
	collectDrift: () => Promise<DriftResult>,
	collectRepos: () => Promise<RepoStatus[]>,
	{ org, now, rank }: { org: string; now: Date; rank?: (repo: string) => number },
): Promise<StatusSnapshot> {
	const drift = await section(async () => buildDriftReport(await collectDrift(), rank));
	const repos = await section(collectRepos);
	return { org, generatedAt: now.toISOString(), drift, repos };
}

/** Listed against the type, so that a new field cannot be forgotten here. */
const REPORT_FIELDS = {
	packages: true,
	dependents: true,
	deployments: true,
	pins: true,
	publishes: true,
	totals: true,
} satisfies Record<keyof DriftReport, true>;

/**
 * A snapshot read back from disk, or null if this version of the code cannot use
 * it. The file is not committed, so it can easily outlive a change to its shape.
 */
export function readStatusSnapshot(text: string): StatusSnapshot | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const { org, generatedAt, drift, repos } = parsed as Partial<
		Record<keyof StatusSnapshot, unknown>
	>;
	if (typeof org !== 'string' || typeof generatedAt !== 'string') return null;

	const reportUsable = (data: object): boolean =>
		Object.keys(REPORT_FIELDS).every((field) => field in data);
	return sectionUsable(drift, reportUsable) && sectionUsable(repos, Array.isArray)
		? (parsed as StatusSnapshot)
		: null;
}

/** A failed section says why, and one that succeeded has data of the right shape. */
function sectionUsable(value: unknown, dataUsable: (data: object) => boolean): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const { status, data, error } = value as { status?: unknown; data?: unknown; error?: unknown };
	if (status === 'failed') return typeof error === 'string';
	return status === 'ok' && typeof data === 'object' && data !== null && dataUsable(data);
}

export function renderStatusJson(snapshot: StatusSnapshot): string {
	return `${JSON.stringify(snapshot, null, '\t')}\n`;
}
