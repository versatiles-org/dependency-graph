/**
 * The open security alerts of all repositories: Dependabot's, and those of code
 * scanning (CodeQL, and Trivy through its SARIF upload).
 *
 * Unlike the rest of the status, these are not public. The token needs the
 * GitHub App's "Dependabot alerts" and "Code scanning alerts" permissions, and
 * the snapshot that holds them must only be served behind a login, as
 * status.versatiles.org does. Without the permissions this section fails on its
 * own and the rest of the status is unaffected.
 *
 * Dependabot's alerts come from one GraphQL query with an alias per repository,
 * code scanning's from one listing for the whole organisation.
 */

import type { GraphQl } from './repo-status';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SecurityAlert {
	repo: string;
	/** Who raised it: Dependabot, or the code scanning tool, such as CodeQL or Trivy. */
	tool: string;
	severity: AlertSeverity;
	/** The advisory (GHSA-…) for Dependabot, the rule (often a CVE) for code scanning. */
	id: string;
	summary: string;
	url: string;
	createdAt: string;
}

/** A paged REST listing below the API root, every page of it. */
export type ListAll = <T>(path: string) => Promise<T[]>;

/** Dependabot's alerts per repository, read in one query under aliases. */
export function dependabotQuery(org: string, repos: string[]): string {
	const lines = repos.map(
		(repo, index) =>
			`  r${index}: repository(owner: ${JSON.stringify(org)}, name: ${JSON.stringify(repo)}) ` +
			'{ vulnerabilityAlerts(states: OPEN, first: 100) { nodes { number createdAt ' +
			'securityVulnerability { severity package { name } advisory { ghsaId summary } } } } }',
	);
	return `query {\n${lines.join('\n')}\n}`;
}

export interface ApiDependabotAlert {
	number: number;
	createdAt: string;
	securityVulnerability: {
		severity: string;
		package: { name: string };
		advisory: { ghsaId: string; summary: string };
	} | null;
}

export interface ApiCodeScanningAlert {
	html_url: string;
	created_at: string;
	repository: { name: string };
	tool: { name: string };
	rule: {
		id: string | null;
		description: string;
		/** Set for security rules: critical, high, medium or low. */
		security_severity_level?: string | null;
		/** Set for every rule: error, warning or note. */
		severity?: string | null;
	};
}

/** GitHub's own scales mapped to one: Dependabot says MODERATE for medium. */
export function severityOf(value: string | null | undefined): AlertSeverity | null {
	switch (value?.toLowerCase()) {
		case 'critical':
			return 'critical';
		case 'high':
			return 'high';
		case 'moderate':
		case 'medium':
			return 'medium';
		case 'low':
			return 'low';
		default:
			return null;
	}
}

export function parseDependabot(
	org: string,
	repo: string,
	alert: ApiDependabotAlert,
): SecurityAlert {
	const vulnerability = alert.securityVulnerability;
	return {
		repo,
		tool: 'Dependabot',
		severity: severityOf(vulnerability?.severity) ?? 'low',
		id: vulnerability?.advisory.ghsaId ?? `#${alert.number}`,
		summary: vulnerability
			? `${vulnerability.package.name}: ${vulnerability.advisory.summary}`
			: 'Unknown advisory',
		url: `https://github.com/${org}/${repo}/security/dependabot/${alert.number}`,
		createdAt: alert.createdAt,
	};
}

/**
 * A rule that isn't about security, such as a CodeQL code-quality query, has no
 * security level; an error then counts as medium and anything else as low.
 */
export function parseCodeScanning(alert: ApiCodeScanningAlert): SecurityAlert {
	const severity =
		severityOf(alert.rule.security_severity_level) ??
		(alert.rule.severity === 'error' ? 'medium' : 'low');
	return {
		repo: alert.repository.name,
		tool: alert.tool.name,
		severity,
		id: alert.rule.id ?? alert.html_url,
		summary: alert.rule.description,
		url: alert.html_url,
		createdAt: alert.created_at,
	};
}

const ORDER: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** The open alerts of the repositories in `names`, the most severe first. */
export async function collectSecurity(
	query: GraphQl,
	listAll: ListAll,
	org: string,
	names: Set<string>,
): Promise<SecurityAlert[]> {
	const repos = [...names].sort();
	const alerts: SecurityAlert[] = [];

	if (repos.length > 0) {
		const answers = await query<
			Record<string, { vulnerabilityAlerts: { nodes: ApiDependabotAlert[] } } | null>
		>(dependabotQuery(org, repos));
		repos.forEach((repo, index) => {
			for (const alert of answers[`r${index}`]?.vulnerabilityAlerts.nodes ?? []) {
				alerts.push(parseDependabot(org, repo, alert));
			}
		});
	}

	const scanned = await listAll<ApiCodeScanningAlert>(
		`/orgs/${org}/code-scanning/alerts?state=open`,
	);
	for (const alert of scanned) {
		if (names.has(alert.repository.name)) alerts.push(parseCodeScanning(alert));
	}

	return alerts.sort(
		(a, b) =>
			ORDER[a.severity] - ORDER[b.severity] ||
			a.repo.localeCompare(b.repo) ||
			a.createdAt.localeCompare(b.createdAt),
	);
}
