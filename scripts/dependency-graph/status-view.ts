/**
 * What the status page does with a snapshot: filtering and wording times. It
 * runs in the browser, so unlike `drift.ts` it may only import types from there.
 */

import type {
	DependentReport,
	DeploymentReport,
	DriftReport,
	Finding,
	PackageReport,
	PinFinding,
} from './drift';
import type { RepoStatus } from './repo-status';

/** Scheduled runs are hours apart, so an older snapshot means they have stopped. */
const STALE_AFTER_HOURS = 12;

const HOUR = 3_600_000;

export function daysAgo(date: string, now: Date): string {
	const days = Math.floor((now.getTime() - new Date(date).getTime()) / (24 * HOUR));
	if (days <= 0) return 'today';
	return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** The age of a snapshot, where hours matter. */
export function hoursAgo(date: string, now: Date): string {
	const hours = Math.floor((now.getTime() - new Date(date).getTime()) / HOUR);
	if (hours < 1) return 'less than an hour ago';
	if (hours >= 48) return daysAgo(date, now);
	return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

export function isStale(date: string, now: Date): boolean {
	return now.getTime() - new Date(date).getTime() > STALE_AFTER_HOURS * HOUR;
}

/** The same text wherever it is rendered, so the server and the browser agree. */
export function formatUtc(date: string): string {
	return `${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** npm's `devDependencies`, and Cargo's `dev-dependencies`, which can sit inside another table. */
export function isDev(finding: Pick<Finding, 'section'>): boolean {
	return /(^|\.)dev-?dependencies$/i.test(finding.section);
}

/** Where a pinned version was found: a file, an image, or a release's notes. */
export function pinLocation(pin: Pick<PinFinding, 'path' | 'image' | 'tag' | 'component'>): string {
	return pin.path ?? pin.image ?? `${pin.tag ?? 'latest release'}: ${pin.component}`;
}

/** What is failing comes first, then the rest by name, so that rows stay where they are. */
export function listRepos(repos: RepoStatus[], query: string): RepoStatus[] {
	const wanted = query.trim().toLowerCase();
	return repos
		.filter((repo) => repo.name.toLowerCase().includes(wanted))
		.sort(
			(a, b) =>
				Number(b.ci === 'failing') - Number(a.ci === 'failing') || a.name.localeCompare(b.name),
		);
}

/** Finds a pin by the repository holding it, the one it names, or where it is. */
export function filterPins(pins: PinFinding[], query: string): PinFinding[] {
	const wanted = query.trim().toLowerCase();
	return pins.filter((pin) =>
		[pin.repo, pin.provider ?? '', pinLocation(pin)].some((text) =>
			text.toLowerCase().includes(wanted),
		),
	);
}

/** Finds a deployment by its repository, or just the components that match. */
export function filterDeployments(
	deployments: DeploymentReport[],
	query: string,
): DeploymentReport[] {
	const wanted = query.trim().toLowerCase();
	const matches = (text: string): boolean => text.toLowerCase().includes(wanted);
	return deployments.flatMap((deployment): DeploymentReport[] => {
		if (matches(deployment.repo)) return [deployment];
		const findings = deployment.findings.filter(
			(finding) => matches(finding.component) || matches(finding.provider ?? ''),
		);
		return findings.length > 0 ? [{ ...deployment, findings }] : [];
	});
}

export interface DriftFilter {
	/** Part of a repository or package name. */
	query: string;
	hideDev: boolean;
	/** Leave out packages whose every usage is current. */
	onlyOutdated: boolean;
}

export interface QueueEntry extends DependentReport {
	/** Place in the whole queue, which a filter must not renumber. */
	position: number;
}

/**
 * What each repository in the queue waits for without being behind on it yet:
 * the others in the queue whose packages it uses, directly or through
 * repositories outside the queue. They come before it, and it will be behind on
 * them as soon as they are released. Like the update order, it counts every
 * usage, development dependencies included.
 */
export function waitingOn(
	report: Pick<DriftReport, 'packages' | 'dependents'>,
): Record<string, string[]> {
	const providers = new Map<string, Set<string>>();
	for (const { consumer, provider } of report.packages.flatMap((entry) => entry.usages)) {
		if (!providers.has(consumer)) providers.set(consumer, new Set());
		providers.get(consumer)!.add(provider);
	}

	const queued = new Set(report.dependents.map((dependent) => dependent.consumer));
	const result: Record<string, string[]> = {};
	for (const { consumer, outdated } of report.dependents) {
		const behind = new Set(outdated.map((usage) => usage.provider));
		const found = new Set<string>();
		const seen = new Set([consumer]);
		const open = [consumer];
		while (open.length > 0) {
			for (const provider of providers.get(open.pop()!) ?? []) {
				if (seen.has(provider)) continue;
				seen.add(provider);
				// One in the queue stands for everything behind it.
				if (!queued.has(provider)) open.push(provider);
				else if (!behind.has(provider)) found.add(provider);
			}
		}
		if (found.size > 0) result[consumer] = [...found].sort((a, b) => a.localeCompare(b));
	}
	return result;
}

export function filterDrift(
	report: DriftReport,
	{ query, hideDev, onlyOutdated }: DriftFilter,
): { queue: QueueEntry[]; packages: PackageReport[] } {
	const wanted = query.trim().toLowerCase();
	const matches = (text: string): boolean => text.toLowerCase().includes(wanted);

	const queue = report.dependents.flatMap((dependent, index): QueueEntry[] => {
		const outdated = dependent.outdated.filter(
			(finding) =>
				!(hideDev && isDev(finding)) && (matches(dependent.consumer) || matches(finding.name)),
		);
		return outdated.length > 0 ? [{ ...dependent, outdated, position: index + 1 }] : [];
	});

	const packages = report.packages.flatMap((entry): PackageReport[] => {
		const named = matches(entry.name) || matches(entry.provider);
		const usages = entry.usages.filter(
			(finding) => !(hideDev && isDev(finding)) && (named || matches(finding.consumer)),
		);
		if (usages.length === 0) return [];
		if (onlyOutdated && usages.every((finding) => finding.status === 'current')) return [];
		return [{ ...entry, usages }];
	});

	return { queue, packages };
}
