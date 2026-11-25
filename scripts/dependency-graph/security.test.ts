import { describe, expect, it } from 'vitest';
import type { GraphQl } from './repo-status';
import {
	collectSecurity,
	dependabotQuery,
	parseCodeScanning,
	parseDependabot,
	severityOf,
	type ApiCodeScanningAlert,
	type ApiDependabotAlert,
	type ListAll,
} from './security';

const dependabot = (number: number, severity: string): ApiDependabotAlert => ({
	number,
	createdAt: `2026-10-0${number}T00:00:00Z`,
	securityVulnerability: {
		severity,
		package: { name: 'urllib3' },
		advisory: { ghsaId: `GHSA-000${number}`, summary: 'A flaw' },
	},
});

const scanned = (
	repo: string,
	rule: Partial<ApiCodeScanningAlert['rule']>,
	tool = 'Trivy',
): ApiCodeScanningAlert => ({
	html_url: `https://github.com/versatiles-org/${repo}/security/code-scanning/1`,
	created_at: '2026-10-05T00:00:00Z',
	repository: { name: repo },
	tool: { name: tool },
	rule: { id: 'CVE-2026-1', description: 'netty: a flaw', ...rule },
});

describe('severityOf', () => {
	it("maps Dependabot's and code scanning's scales to one", () => {
		expect(severityOf('CRITICAL')).toBe('critical');
		expect(severityOf('HIGH')).toBe('high');
		expect(severityOf('MODERATE')).toBe('medium');
		expect(severityOf('medium')).toBe('medium');
		expect(severityOf('LOW')).toBe('low');
		expect(severityOf(null)).toBeNull();
		expect(severityOf('note')).toBeNull();
	});
});

describe('dependabotQuery', () => {
	it('asks for every repository under an alias of its place', () => {
		const query = dependabotQuery('versatiles-org', ['a', 'b']);
		expect(query).toContain('r0: repository(owner: "versatiles-org", name: "a")');
		expect(query).toContain('r1: repository(owner: "versatiles-org", name: "b")');
		expect(query).toContain('vulnerabilityAlerts(states: OPEN');
	});
});

describe('parseDependabot', () => {
	it('names the package and links the alert', () => {
		expect(parseDependabot('versatiles-org', 'a', dependabot(3, 'MODERATE'))).toEqual({
			repo: 'a',
			tool: 'Dependabot',
			severity: 'medium',
			id: 'GHSA-0003',
			summary: 'urllib3: A flaw',
			url: 'https://github.com/versatiles-org/a/security/dependabot/3',
			createdAt: '2026-10-03T00:00:00Z',
		});
	});
});

describe('parseCodeScanning', () => {
	it('takes the security level, and falls back on the rule severity', () => {
		expect(
			parseCodeScanning(scanned('a', { security_severity_level: 'critical' })).severity,
		).toBe('critical');
		expect(parseCodeScanning(scanned('a', { severity: 'error' })).severity).toBe('medium');
		expect(parseCodeScanning(scanned('a', { severity: 'warning' })).severity).toBe('low');
	});

	it('keeps the tool, the rule and the link', () => {
		expect(
			parseCodeScanning(scanned('a', { security_severity_level: 'high' }, 'CodeQL')),
		).toEqual({
			repo: 'a',
			tool: 'CodeQL',
			severity: 'high',
			id: 'CVE-2026-1',
			summary: 'netty: a flaw',
			url: 'https://github.com/versatiles-org/a/security/code-scanning/1',
			createdAt: '2026-10-05T00:00:00Z',
		});
	});
});

describe('collectSecurity', () => {
	const query = (answers: Record<string, unknown>): GraphQl =>
		(() => Promise.resolve(answers)) as GraphQl;
	const listing =
		(alerts: ApiCodeScanningAlert[], asked: string[] = []): ListAll =>
		<T>(path: string) => {
			asked.push(path);
			return Promise.resolve(alerts as T[]);
		};

	it('joins both sources, only for the covered repositories, the most severe first', async () => {
		const asked: string[] = [];
		const alerts = await collectSecurity(
			query({
				r0: { vulnerabilityAlerts: { nodes: [dependabot(1, 'LOW')] } },
				r1: { vulnerabilityAlerts: { nodes: [dependabot(2, 'HIGH')] } },
			}),
			listing(
				[
					scanned('b', { security_severity_level: 'critical' }),
					scanned('private-one', { security_severity_level: 'critical' }),
				],
				asked,
			),
			'versatiles-org',
			new Set(['b', 'a']),
		);
		expect(asked).toEqual(['/orgs/versatiles-org/code-scanning/alerts?state=open']);
		expect(alerts.map((a) => `${a.repo} ${a.tool} ${a.severity}`)).toEqual([
			'b Trivy critical',
			'b Dependabot high',
			'a Dependabot low',
		]);
	});

	it('copes with a repository the query could not find', async () => {
		const alerts = await collectSecurity(
			query({ r0: null }),
			listing([]),
			'versatiles-org',
			new Set(['a']),
		);
		expect(alerts).toEqual([]);
	});

	it('fails when a source fails, rather than reporting nothing open', async () => {
		const failing: GraphQl = () => Promise.reject(new Error('GraphQL: Resource not accessible'));
		await expect(
			collectSecurity(failing, listing([]), 'versatiles-org', new Set(['a'])),
		).rejects.toThrow('Resource not accessible');
	});
});
