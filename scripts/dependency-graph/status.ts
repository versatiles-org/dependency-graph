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

export type StatusSection<T> = { status: 'ok'; data: T } | { status: 'failed'; error: string };

export interface StatusSnapshot {
	/** The GitHub organisation the repository names belong to. */
	org: string;
	/** When the data was collected, as an ISO date. */
	generatedAt: string;
	drift: StatusSection<DriftReport>;
}

export async function buildStatusSnapshot(
	collectDrift: () => Promise<DriftResult>,
	{ org, now, rank }: { org: string; now: Date; rank?: (repo: string) => number },
): Promise<StatusSnapshot> {
	let drift: StatusSection<DriftReport>;
	try {
		drift = { status: 'ok', data: buildDriftReport(await collectDrift(), rank) };
	} catch (error) {
		drift = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
	}
	return { org, generatedAt: now.toISOString(), drift };
}

/** Listed against the type, so that a new field cannot be forgotten here. */
const REPORT_FIELDS = {
	packages: true,
	dependents: true,
	deployments: true,
	pins: true,
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
	const { org, generatedAt, drift } = parsed as Partial<Record<keyof StatusSnapshot, unknown>>;
	if (typeof org !== 'string' || typeof generatedAt !== 'string') return null;
	if (typeof drift !== 'object' || drift === null) return null;

	const section = drift as { status?: unknown; data?: unknown; error?: unknown };
	if (section.status === 'failed' && typeof section.error === 'string') {
		return parsed as StatusSnapshot;
	}
	if (section.status !== 'ok' || typeof section.data !== 'object' || section.data === null) {
		return null;
	}
	const data = section.data;
	return Object.keys(REPORT_FIELDS).every((field) => field in data)
		? (parsed as StatusSnapshot)
		: null;
}

export function renderStatusJson(snapshot: StatusSnapshot): string {
	return `${JSON.stringify(snapshot, null, '\t')}\n`;
}
