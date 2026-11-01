/**
 * What the status page does with a snapshot: filtering and wording times. It
 * runs in the browser, so unlike `drift.ts` it may only import types from there.
 */

import type { DependentReport, DriftReport, Finding, PackageReport } from './drift';

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

export function isDev(finding: Pick<Finding, 'section'>): boolean {
	return finding.section.startsWith('dev');
}

/** Some fixes are commands to run, others are instructions to read. */
export function isCommand(fix: string): boolean {
	return /^(cd|npm|cargo) /.test(fix);
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
