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

export function renderStatusJson(snapshot: StatusSnapshot): string {
	return `${JSON.stringify(snapshot, null, '\t')}\n`;
}
