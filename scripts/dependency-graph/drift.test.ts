import { describe, expect, it } from 'vitest';
import { buildNameMaps, classify, type RepoFile } from './collect';
import {
	assess,
	assessDeployment,
	buildDriftReport,
	cargoRequirements,
	collectBundles,
	collectDeployments,
	collectDrift,
	collectPins,
	findUsages,
	imageTagsUrl,
	lockCandidates,
	lockedVersion,
	manifestVersions,
	newestImageTag,
	parseComponents,
	parseRegistry,
	publishedPackages,
	readPin,
	registryUrl,
	renderDrift,
	updateOrder,
	toRange,
	type DriftSource,
	type Release,
	type Usage,
} from './drift';
import { mapLimit } from './github';

function file(repo: string, path: string, text: string): RepoFile {
	const role = classify(path);
	if (!role) throw new Error(`${path} is not a file the collector reads`);
	return { repo, path, role, text };
}

const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
	JSON.stringify({ name, version: '1.0.0', ...extra });

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		ecosystem: 'npm',
		name: '@versatiles/style',
		provider: 'versatiles-style',
		consumer: 'versatiles-frontend',
		path: 'package.json',
		section: 'dependencies',
		requested: '^6.0.1',
		installed: '6.0.1',
		lockPath: 'package-lock.json',
		...overrides,
	};
}

const release = (version: string): Release => ({ version, date: null, source: 'registry' });

describe('findUsages', () => {
	it('lists npm dependencies on other repositories, with their section', () => {
		const files = [
			file('versatiles-style', 'package.json', pkg('@versatiles/style')),
			file(
				'versatiles-frontend',
				'package.json',
				pkg('versatiles-frontend', {
					dependencies: { '@versatiles/style': '^6.0.1', lodash: '^4' },
					devDependencies: { '@versatiles/style': '^6.0.1' },
				}),
			),
		];
		const { maps } = buildNameMaps(files);
		const found = findUsages(files, maps).map((u) => `${u.consumer} ${u.section} ${u.requested}`);
		expect(found).toEqual([
			'versatiles-frontend dependencies ^6.0.1',
			'versatiles-frontend devDependencies ^6.0.1',
		]);
	});

	it('leaves out packages from the same repository', () => {
		const files = [
			file('mono', 'a/package.json', pkg('@versatiles/a')),
			file(
				'mono',
				'b/package.json',
				pkg('@versatiles/b', { dependencies: { '@versatiles/a': '*' } }),
			),
		];
		const { maps } = buildNameMaps(files);
		expect(findUsages(files, maps)).toEqual([]);
	});

	it('records a workspace crate in the root table, not in the members inheriting it', () => {
		const files = [
			file(
				'versatiles-rs',
				'versatiles_core/Cargo.toml',
				'[package]\nname = "versatiles_core"\n',
			),
			file(
				'versatiles-studio',
				'Cargo.toml',
				'[workspace]\n\n[workspace.dependencies]\nversatiles_core = "4.12.2"\n',
			),
			file(
				'versatiles-studio',
				'src-tauri/Cargo.toml',
				'[package]\nname = "studio"\n\n[dependencies]\nversatiles_core.workspace = true\n',
			),
		];
		const { maps } = buildNameMaps(files);
		const found = findUsages(files, maps);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			path: 'Cargo.toml',
			section: 'workspace.dependencies',
			requested: '4.12.2',
		});
	});
});

describe('cargoRequirements', () => {
	it('reads the three ways a dependency is written', () => {
		const text = [
			'[dependencies]',
			'a = "1.2"',
			'b = { version = "0.3", features = ["x"] }',
			'c = { git = "https://github.com/versatiles-org/c" }',
			'd.workspace = true',
			'',
			'[dev-dependencies.e]',
			'version = "2"',
			'',
			'[package.metadata]',
			'f = "9"',
		].join('\n');
		expect(cargoRequirements(text)).toEqual([
			{ crate: 'a', section: 'dependencies', version: '1.2' },
			{ crate: 'b', section: 'dependencies', version: '0.3' },
			{ crate: 'c', section: 'dependencies', git: 'https://github.com/versatiles-org/c' },
			{ crate: 'd', section: 'dependencies', workspace: true },
			{ crate: 'e', section: 'dev-dependencies', version: '2' },
		]);
	});
});

describe('manifestVersions', () => {
	it('reads npm versions and Cargo versions, inherited ones included', () => {
		const files = [
			file('style', 'package.json', pkg('@versatiles/style', { version: '6.0.3' })),
			file('rs', 'Cargo.toml', '[workspace.package]\nversion = "4.15.0"\n'),
			file('rs', 'core/Cargo.toml', '[package]\nname = "core"\nversion.workspace = true\n'),
			file('rs', 'own/Cargo.toml', '[package]\nname = "own"\nversion = "0.1.0"\n'),
		];
		expect(Object.fromEntries(manifestVersions(files))).toEqual({
			'@versatiles/style': '6.0.3',
			core: '4.15.0',
			own: '0.1.0',
		});
	});
});

describe('publishedPackages', () => {
	it('lists what a repository offers, sorted, and leaves out what is private', () => {
		const files = [
			file('lib', 'package.json', pkg('@versatiles/lib')),
			file('lib', 'extra/package.json', pkg('@versatiles/another')),
			file('app', 'package.json', pkg('app', { private: true })),
			file('mixed', 'package.json', pkg('mixed', { private: true })),
			file('mixed', 'export/package.json', pkg('@versatiles/export')),
			file('rs', 'core/Cargo.toml', '[package]\nname = "core"\n'),
			file('rs', 'cli/Cargo.toml', '[package]\nname = "cli"\npublish = false\n'),
			file('rs', 'Cargo.toml', '[workspace]\nmembers = ["core"]\n'),
			file('broken', 'package.json', 'not json'),
		];
		expect(publishedPackages(files)).toEqual({
			lib: ['@versatiles/another', '@versatiles/lib'],
			mixed: ['@versatiles/export'],
			rs: ['core'],
		});
	});
});

describe('lockfiles', () => {
	it('looks next to the manifest first, then upwards', () => {
		expect(lockCandidates('a/b/package.json', 'npm')).toEqual([
			'a/b/package-lock.json',
			'a/package-lock.json',
			'package-lock.json',
		]);
		expect(lockCandidates('Cargo.toml', 'cargo')).toEqual(['Cargo.lock']);
	});

	it('prefers a nested npm install over the hoisted one', () => {
		const lock = JSON.stringify({
			packages: {
				'node_modules/@versatiles/style': { version: '5.13.1' },
				'app/node_modules/@versatiles/style': { version: '6.0.3' },
			},
		});
		expect(lockedVersion(usage({ path: 'app/package.json' }), 'package-lock.json', lock)).toBe(
			'6.0.3',
		);
		expect(lockedVersion(usage({ path: 'other/package.json' }), 'package-lock.json', lock)).toBe(
			'5.13.1',
		);
	});

	it('reads version 1 npm lockfiles', () => {
		const lock = JSON.stringify({ dependencies: { '@versatiles/style': { version: '5.0.0' } } });
		expect(lockedVersion(usage(), 'package-lock.json', lock)).toBe('5.0.0');
		expect(lockedVersion(usage(), 'package-lock.json', 'not json')).toBeNull();
	});

	it('picks the highest locked crate version the requirement admits', () => {
		const lock = [
			'[[package]]\nname = "versatiles_core"\nversion = "3.9.0"\n',
			'[[package]]\nname = "versatiles_core"\nversion = "4.12.2"\n',
			'[[package]]\nname = "other"\nversion = "9.0.0"\n',
		].join('\n');
		const cargo = usage({ ecosystem: 'cargo', name: 'versatiles_core', requested: '3.1' });
		expect(lockedVersion(cargo, 'Cargo.lock', lock)).toBe('3.9.0');
		expect(lockedVersion({ ...cargo, requested: 'git: x' }, 'Cargo.lock', lock)).toBe('4.12.2');
		expect(lockedVersion({ ...cargo, name: 'missing' }, 'Cargo.lock', lock)).toBeNull();
	});
});

describe('registries', () => {
	it('builds registry URLs', () => {
		expect(registryUrl('npm', '@versatiles/style')).toBe(
			'https://registry.npmjs.org/@versatiles%2fstyle',
		);
		expect(registryUrl('cargo', 'versatiles_core')).toBe(
			'https://crates.io/api/v1/crates/versatiles_core',
		);
	});

	it('reads the latest release and its date', () => {
		expect(
			parseRegistry('npm', {
				'dist-tags': { latest: '6.0.3' },
				time: { '6.0.3': '2026-09-28' },
			}),
		).toEqual({ version: '6.0.3', date: '2026-09-28', source: 'registry' });
		expect(
			parseRegistry('cargo', {
				crate: { max_stable_version: '4.15.0', max_version: '5.0.0-beta' },
				versions: [{ num: '4.15.0', created_at: '2026-09-20' }],
			}),
		).toEqual({ version: '4.15.0', date: '2026-09-20', source: 'registry' });
		expect(parseRegistry('npm', null)).toBeNull();
		expect(parseRegistry('npm', {})).toBeNull();
		expect(parseRegistry('cargo', { crate: {} })).toBeNull();
	});
});

describe('toRange', () => {
	it('reads Cargo requirements with Cargo’s defaults', () => {
		expect(toRange({ ecosystem: 'cargo', requested: '4.12' })).toBe('>=4.12.0 <5.0.0-0');
		expect(toRange({ ecosystem: 'cargo', requested: '>=1, <2' })).toBe('>=1.0.0 <2.0.0-0');
		expect(toRange({ ecosystem: 'cargo', requested: '=1.2.3' })).toBe('1.2.3');
	});

	it('rejects what is not a range', () => {
		expect(toRange({ ecosystem: 'npm', requested: 'github:versatiles-org/x' })).toBeNull();
		expect(toRange({ ecosystem: 'npm', requested: 'workspace:*' })).toBeNull();
	});
});

describe('assess', () => {
	it('tells a stale lockfile from a range that needs changing', () => {
		expect(assess(usage(), release('6.0.3'))).toMatchObject({
			status: 'stale-lock',
			behind: 'patch',
			fix: 'npm update @versatiles/style',
		});
		expect(
			assess(usage({ requested: '^5.13.1', installed: '5.13.1' }), release('6.0.3')),
		).toMatchObject({
			status: 'range',
			behind: 'major',
			fix: 'npm install @versatiles/style@^6.0.3',
		});
	});

	it('suggests fixes that fit the section and location', () => {
		const old = { requested: '^5.0.0', installed: '5.0.0' };
		expect(assess(usage({ ...old, section: 'devDependencies' }), release('6.0.0')).fix).toBe(
			'npm install -D @versatiles/style@^6.0.0',
		);
		expect(assess(usage({ ...old, section: 'optionalDependencies' }), release('6.0.0')).fix).toBe(
			'npm install -O @versatiles/style@^6.0.0',
		);
		expect(assess(usage({ ...old, section: 'peerDependencies' }), release('6.0.0')).fix).toBe(
			'widen the peer range to include 6.0.0',
		);
		expect(assess(usage({ path: 'web/package.json' }), release('6.1.0'))).toMatchObject({
			behind: 'minor',
			fix: 'cd web && npm update @versatiles/style',
		});

		const cargo = usage({
			ecosystem: 'cargo',
			name: 'versatiles_core',
			path: 'Cargo.toml',
			requested: '4.12.2',
			installed: '4.12.2',
		});
		expect(assess(cargo, release('4.15.0')).fix).toBe('cargo update -p versatiles_core');
		expect(assess(cargo, release('5.0.0')).fix).toBe(
			'set versatiles_core = "5.0.0" in Cargo.toml',
		);
	});

	it('reports current, ahead and unknown', () => {
		expect(assess(usage({ installed: '6.0.3' }), release('6.0.3')).status).toBe('current');
		expect(assess(usage({ installed: '6.1.0' }), release('6.0.3')).status).toBe('ahead');
		expect(assess(usage(), null).status).toBe('unknown');
		expect(assess(usage({ requested: 'github:x/y' }), release('6.0.3')).status).toBe('unknown');
		expect(assess(usage({ installed: 'weird' }), release('6.0.3')).status).toBe('unknown');
	});

	it('judges an unlocked dependency by its range alone', () => {
		expect(assess(usage({ installed: null }), release('6.0.3')).status).toBe('current');
		expect(
			assess(usage({ installed: null, requested: '^1.1.0' }), release('2.2.0')),
		).toMatchObject({ status: 'range', behind: 'major' });
	});
});

describe('collectDrift', () => {
	it('reads lockfiles once and falls back to the manifest for unpublished packages', async () => {
		const files = [
			file('versatiles-style', 'package.json', pkg('@versatiles/style', { version: '6.0.3' })),
			file('private-lib', 'package.json', pkg('@versatiles/private', { version: '0.2.0' })),
			file(
				'frontend',
				'package.json',
				pkg('frontend', {
					dependencies: { '@versatiles/style': '^6.0.1', '@versatiles/private': '^0.1.0' },
				}),
			),
		];
		const { maps } = buildNameMaps(files);
		const reads: string[] = [];
		const source: DriftSource = {
			readFile: (repo, path) => {
				reads.push(`${repo}/${path}`);
				return Promise.resolve(
					JSON.stringify({
						packages: {
							'node_modules/@versatiles/style': { version: '6.0.1' },
							'node_modules/@versatiles/private': { version: '0.1.0' },
						},
					}),
				);
			},
			latestRelease: () => Promise.resolve(null),
			getRegistryJson: (url) =>
				Promise.resolve(
					url.includes('style')
						? { 'dist-tags': { latest: '6.0.3' }, time: { '6.0.3': '2026-09-20T00:00:00Z' } }
						: null,
				),
		};

		const result = await collectDrift(files, maps, source, mapLimit);
		expect(reads).toEqual(['frontend/package-lock.json']);
		expect(result.findings.map((f) => `${f.name} ${f.status}`).sort()).toEqual([
			'@versatiles/private range',
			'@versatiles/style stale-lock',
		]);
		expect(result.releases.get('npm:@versatiles/private')).toEqual({
			version: '0.2.0',
			date: null,
			source: 'manifest',
		});

		const report = renderDrift(result, {
			color: false,
			now: new Date('2026-09-28T00:00:00Z'),
			onlyOutdated: false,
		});
		expect(report).toContain('@versatiles/style 6.0.3  npm · from versatiles-style');
		expect(report).toContain('released 2026-09-20 (8 days ago)');
		expect(report).toContain('not published, version on main');
		expect(report).not.toContain('npm update');
		expect(report).toContain('frontend  2 outdated');
		expect(report).toMatch(/2 packages, 2 usages: 1 range excludes latest, 1 stale-lock$/);
	});
});

describe('pinned releases', () => {
	const formula = 'class Versatiles < Formula\n  version "5.4.0"\nend\n';
	const manifest = JSON.stringify({
		sources: { sprites: { assets: { a: { digest: 'x' } }, repo: 'r', version: 'v7.1.0' } },
	});

	describe('readPin', () => {
		it('reads a version from the first group of a pattern', () => {
			expect(readPin(formula, { pattern: 'version "([^"]+)"' })).toBe('5.4.0');
			expect(readPin(formula, { pattern: 'nothing "([^"]+)"' })).toBeNull();
		});

		it('follows a path through JSON', () => {
			expect(readPin(manifest, { json: 'sources.sprites.version' })).toBe('v7.1.0');
			expect(readPin(manifest, { json: 'sources.fonts.version' })).toBeNull();
			expect(readPin(manifest, { json: 'sources.sprites.assets' })).toBeNull();
			expect(readPin('not json', { json: 'a' })).toBeNull();
		});
	});

	describe('newestImageTag', () => {
		const tags = (...names: unknown[]) => ({ results: names.map((name) => ({ name })) });

		it('takes the highest version, whatever order the tags come in', () => {
			expect(newestImageTag(tags('v5.4.1', 'v5.10.0', 'v5.5.0'))).toBe('v5.10.0');
		});

		it('ignores variants and moving tags', () => {
			expect(newestImageTag(tags('latest', 'scratch', 'v5.9.0-alpine', 'v5.5.0', 3))).toBe(
				'v5.5.0',
			);
		});

		it('has no answer without a version tag', () => {
			expect(newestImageTag(tags('latest'))).toBeNull();
			expect(newestImageTag(null)).toBeNull();
			expect(newestImageTag({})).toBeNull();
		});
	});

	describe('collectPins', () => {
		const pins = [
			{ repo: 'brew', path: 'old.rb', provider: 'rs', pattern: 'version "([^"]+)"' },
			{ repo: 'brew', path: 'gone.rb', provider: 'rs', pattern: 'version "([^"]+)"' },
			{ repo: 'brew', path: 'moved.rb', provider: 'rs', pattern: 'version "([^"]+)"' },
			{ repo: 'brew', path: 'broken.rb', provider: 'rs', pattern: 'version "([^"]+)"' },
			{
				repo: 'studio',
				path: 'manifest.json',
				provider: 'style',
				json: 'sources.sprites.version',
			},
		];
		const images = [
			{ image: 'org/fresh', repo: 'docker', provider: 'rs' },
			{ image: 'org/stale', repo: 'docker', provider: 'rs' },
			{ image: 'org/down', repo: 'docker', provider: 'rs' },
		];
		const source: DriftSource = {
			readFile: (_repo, path) => {
				if (path === 'old.rb') return Promise.resolve(formula);
				if (path === 'moved.rb') return Promise.resolve('no version here');
				if (path === 'broken.rb') return Promise.reject(new Error('502'));
				if (path === 'manifest.json') return Promise.resolve(manifest);
				return Promise.resolve(null);
			},
			latestRelease: (repo) =>
				Promise.resolve({
					version: repo === 'rs' ? 'v5.5.0' : 'v7.1.0',
					date: null,
					source: 'release',
				}),
			getRegistryJson: (url) => {
				if (url === imageTagsUrl('org/fresh')) {
					return Promise.resolve({ results: [{ name: 'v5.5.0' }] });
				}
				if (url === imageTagsUrl('org/stale')) {
					return Promise.resolve({ results: [{ name: 'v5.3.0' }] });
				}
				return Promise.reject(new Error('down'));
			},
		};

		it('compares every pin, and reports the ones it cannot read', async () => {
			const found = await collectPins(pins, images, source, mapLimit);
			expect(
				found.map((pin) => [
					pin.path ?? pin.image,
					pin.pinned,
					pin.status,
					pin.behind,
					pin.note,
				]),
			).toEqual([
				['old.rb', '5.4.0', 'behind', 'minor', 'update the pin'],
				['gone.rb', null, 'unknown', null, 'file could not be read'],
				['moved.rb', null, 'unknown', null, 'no version found where the configuration says'],
				['broken.rb', null, 'unknown', null, 'file could not be read'],
				['manifest.json', '7.1.0', 'current', null, ''],
				['org/fresh', '5.5.0', 'current', null, ''],
				['org/stale', '5.3.0', 'behind', 'minor', 'update the pin'],
				['org/down', null, 'unknown', null, 'no version tag could be read'],
			]);
		});

		it('leaves pins unknown when the latest release cannot be read', async () => {
			const [pin] = await collectPins(
				pins.slice(0, 1),
				[],
				{ ...source, latestRelease: () => Promise.reject(new Error('502')) },
				mapLimit,
			);
			expect(pin).toMatchObject({
				pinned: '5.4.0',
				status: 'unknown',
				note: 'versions cannot be compared',
			});
		});

		it('sorts what is behind first, counts it and prints it', async () => {
			const found = await collectPins(pins, images, source, mapLimit);
			const result = { findings: [], releases: new Map(), pins: found };
			const report = buildDriftReport(result);
			expect(report.pins.slice(0, 2).map((pin) => pin.status)).toEqual(['behind', 'behind']);
			expect(report.totals.pinsBehind).toBe(2);
			expect(report.pins.at(-1)?.status).toBe('current');

			const text = renderDrift(result, {
				color: false,
				now: new Date(),
				onlyOutdated: true,
			});
			expect(text).toContain('Pinned releases');
			expect(text).toMatch(
				/↑ {2}brew\/old\.rb +5\.4\.0 → 5\.5\.0 {2}rs {2}minor behind, update the pin/,
			);
			expect(text).toContain('docker/org/stale');
			// Current pins stay out of a report of what is outdated.
			expect(text).not.toContain('org/fresh');
			expect(text).toMatch(/2 pinned behind$/);
		});
	});
});

describe('bundled releases', () => {
	const NOTES = [
		'# VersaTiles Frontend 3.16.1',
		'',
		'## Components',
		'',
		'- [VersaTiles Fonts v3.0.0](https://github.com/versatiles-org/versatiles-fonts)',
		'- [VersaTiles Style v7.0.1](https://github.com/versatiles-org/versatiles-style)',
		'- [MapLibre GL JS v6.14.0](https://maplibre.org/maplibre-gl-js/docs/)',
		'- [Brand New Thing v1.0.0](https://example.org)',
		'',
		'## Frontends',
		'',
		'- [Not A Component v9.9.9](https://example.org)',
	].join('\n');

	describe('parseComponents', () => {
		it('reads the list under its heading, and nothing after it', () => {
			expect(parseComponents(NOTES)).toEqual([
				{ name: 'VersaTiles Fonts', version: '3.0.0' },
				{ name: 'VersaTiles Style', version: '7.0.1' },
				{ name: 'MapLibre GL JS', version: '6.14.0' },
				{ name: 'Brand New Thing', version: '1.0.0' },
			]);
		});

		it('copes with Windows line endings, which edited notes come back with', () => {
			expect(parseComponents(NOTES.replaceAll('\n', '\r\n'))).toHaveLength(4);
		});

		it('finds nothing without the heading', () => {
			expect(parseComponents('# Release\n\n- [Thing v1.0.0](https://example.org)')).toEqual([]);
			expect(parseComponents('')).toEqual([]);
		});
	});

	describe('collectBundles', () => {
		const bundle = {
			repo: 'versatiles-frontend',
			components: {
				'VersaTiles Fonts': 'versatiles-fonts',
				'VersaTiles Style': 'versatiles-style',
				'VersaTiles Gone': 'versatiles-gone',
			},
			ignore: ['MapLibre GL JS'],
		};
		const release = (version: string): Release => ({ version, date: null, source: 'release' });
		const source = {
			latestRelease: (repo: string) =>
				Promise.resolve(release(repo === 'versatiles-style' ? 'v7.1.0' : 'v3.0.0')),
			releaseNotes: () => Promise.resolve({ tag: 'v3.16.1', notes: NOTES }),
		};
		const rows = (found: Awaited<ReturnType<typeof collectBundles>>) =>
			found.map((pin) => [pin.component, pin.pinned, pin.status, pin.behind, pin.note]);

		it('compares what is listed, and reports what is missing or unplaced', async () => {
			const found = await collectBundles([bundle], source, mapLimit);
			expect(rows(found)).toEqual([
				['VersaTiles Fonts', '3.0.0', 'current', null, ''],
				['VersaTiles Style', '7.0.1', 'behind', 'minor', 'needs a new release'],
				['VersaTiles Gone', null, 'unknown', null, 'not in the release notes'],
				[
					'Brand New Thing',
					'1.0.0',
					'unknown',
					null,
					'not in the configuration, so not compared',
				],
			]);
			expect(found[1]).toMatchObject({
				repo: 'versatiles-frontend',
				tag: 'v3.16.1',
				provider: 'versatiles-style',
				path: null,
				image: null,
			});
			expect(found[3].provider).toBeNull();
		});

		it('leaves out what is knowingly not compared', async () => {
			const found = await collectBundles([bundle], source, mapLimit);
			expect(found.map((pin) => pin.component)).not.toContain('MapLibre GL JS');
		});

		it('reports every component when the notes cannot be read', async () => {
			const found = await collectBundles(
				[bundle],
				{ ...source, releaseNotes: () => Promise.reject(new Error('502')) },
				mapLimit,
			);
			expect(found).toHaveLength(3);
			for (const pin of found) {
				expect(pin).toMatchObject({
					status: 'unknown',
					tag: null,
					note: 'release notes could not be read',
				});
			}
		});

		it('notices when the notes stop listing components', async () => {
			const found = await collectBundles(
				[bundle],
				{
					...source,
					releaseNotes: () => Promise.resolve({ tag: 'v4.0.0', notes: 'Changed.' }),
				},
				mapLimit,
			);
			expect(found.map((pin) => pin.note)).toEqual(Array(3).fill('not in the release notes'));
		});

		it('prints bundled components with the release they are in', async () => {
			const pins = await collectBundles([bundle], source, mapLimit);
			const text = renderDrift(
				{ findings: [], releases: new Map(), pins },
				{ color: false, now: new Date(), onlyOutdated: true },
			);
			expect(text).toContain('versatiles-frontend/v3.16.1: VersaTiles Style');
			expect(text).toMatch(
				/7\.0\.1 → 7\.1\.0 {2}versatiles-style {2}minor behind, needs a new release/,
			);
			expect(text).toMatch(/1 pinned behind$/);
		});
	});
});

describe('collectDrift when a lockfile cannot be read', () => {
	const files = [
		file('versatiles-style', 'package.json', pkg('@versatiles/style', { version: '6.0.3' })),
		file(
			'broken',
			'package.json',
			pkg('broken', { dependencies: { '@versatiles/style': '^6.0.1' } }),
		),
		file(
			'working',
			'package.json',
			pkg('working', { dependencies: { '@versatiles/style': '^6.0.1' } }),
		),
		file(
			'unlocked',
			'package.json',
			pkg('unlocked', { dependencies: { '@versatiles/style': '^6.0.1' } }),
		),
	];
	const source: DriftSource = {
		readFile: (repo) => {
			if (repo === 'broken') return Promise.reject(new Error('502'));
			if (repo === 'unlocked') return Promise.resolve(null);
			return Promise.resolve(
				JSON.stringify({
					packages: { 'node_modules/@versatiles/style': { version: '6.0.1' } },
				}),
			);
		},
		latestRelease: () => Promise.resolve(null),
		getRegistryJson: () =>
			Promise.resolve({ 'dist-tags': { latest: '6.0.3' }, time: { '6.0.3': '2026-09-20' } }),
	};

	it('leaves that usage unknown, and the rest of the report intact', async () => {
		const { maps } = buildNameMaps(files);
		const { findings } = await collectDrift(files, maps, source, mapLimit);
		const byConsumer = new Map(findings.map((finding) => [finding.consumer, finding]));
		expect(byConsumer.get('broken')).toMatchObject({
			status: 'unknown',
			note: 'lockfile could not be read',
			behind: null,
			fix: null,
		});
		expect(byConsumer.get('working')?.status).toBe('stale-lock');
		// Having no lockfile is a different thing, and still judged by its range.
		expect(byConsumer.get('unlocked')?.status).toBe('current');
	});
});

describe('collectDrift when a registry fails', () => {
	it('leaves that package unknown, and the rest of the report intact', async () => {
		const files = [
			file('versatiles-style', 'package.json', pkg('@versatiles/style', { version: '6.0.3' })),
			file('versatiles-fonts', 'package.json', pkg('@versatiles/fonts', { version: '2.0.0' })),
			file(
				'frontend',
				'package.json',
				pkg('frontend', {
					dependencies: { '@versatiles/style': '^6.0.1', '@versatiles/fonts': '^2.0.0' },
				}),
			),
		];
		const { maps } = buildNameMaps(files);
		const source: DriftSource = {
			readFile: () =>
				Promise.resolve(
					JSON.stringify({
						packages: {
							'node_modules/@versatiles/style': { version: '6.0.1' },
							'node_modules/@versatiles/fonts': { version: '2.0.0' },
						},
					}),
				),
			latestRelease: () => Promise.resolve(null),
			getRegistryJson: (url) =>
				url.includes('style')
					? Promise.reject(new Error('503'))
					: Promise.resolve({ 'dist-tags': { latest: '2.0.0' } }),
		};

		const result = await collectDrift(files, maps, source, mapLimit);
		expect(result.findings.map((f) => `${f.name} ${f.status}`).sort()).toEqual([
			'@versatiles/fonts current',
			'@versatiles/style unknown',
		]);
		// Not the version on main: that would pass off a guess as the latest release.
		expect(result.releases.get('npm:@versatiles/style')).toBeNull();
	});
});

describe('buildDriftReport', () => {
	const style = release('6.0.3');
	const core = usage({ name: '@versatiles/core', provider: 'versatiles-core' });
	const result = {
		findings: [
			assess(usage({ consumer: 'a', installed: '6.0.3' }), style),
			assess(usage({ consumer: 'b', requested: '^5.0.0', installed: '5.0.0' }), style),
			assess(usage({ consumer: 'c', path: 'web/package.json' }), style),
			assess(usage({ consumer: 'c', installed: null, requested: '^5.0.0' }), style),
			assess({ ...core, consumer: 'versatiles-style' }, release('6.1.0')),
		],
		releases: new Map([
			['npm:@versatiles/style', style],
			['npm:@versatiles/core', release('6.1.0')],
		]),
	};

	it('sorts packages by name, and each usage worst first', () => {
		const { packages } = buildDriftReport(result);
		expect(packages.map((entry) => entry.name)).toEqual([
			'@versatiles/core',
			'@versatiles/style',
		]);
		expect(packages[1].usages.map((entry) => `${entry.consumer} ${entry.status}`)).toEqual([
			'b range',
			'c range',
			'c stale-lock',
			'a current',
		]);
		expect(packages[1]).toMatchObject({ provider: 'versatiles-style', release: style });
	});

	it('counts the versions in use, newest first, and names what is not locked', () => {
		expect(buildDriftReport(result).packages[1].spread).toEqual([
			{ version: '6.0.3', count: 1 },
			{ version: '6.0.1', count: 1 },
			{ version: '5.0.0', count: 1 },
			{ version: '^5.0.0 (unlocked)', count: 1 },
		]);
	});

	it('lists only repositories with something to update, in the order to update them', () => {
		const { dependents } = buildDriftReport(result);
		// b and c use @versatiles/style, so they wait until versatiles-style has been updated.
		expect(dependents.map((entry) => entry.consumer)).toEqual(['versatiles-style', 'b', 'c']);
		expect(dependents.find((entry) => entry.consumer === 'b')?.outdated[0]).toMatchObject({
			name: '@versatiles/style',
			installed: '5.0.0',
			latest: '6.0.3',
		});
	});

	it('lets the rank decide between repositories that are independent', () => {
		const { dependents } = buildDriftReport(result, (repo) => (repo === 'c' ? 0 : 1));
		expect(dependents.map((entry) => entry.consumer)).toEqual(['versatiles-style', 'c', 'b']);
	});

	it('says that the latest release is unknown instead of leaving the usage out', () => {
		const { dependents } = buildDriftReport({
			findings: [
				assess(
					usage({ consumer: 'a', requested: '^1.0.0', installed: '1.0.0' }),
					release('2.0.0'),
				),
			],
			releases: new Map(),
		});
		expect(dependents[0].outdated[0].latest).toBeNull();
	});

	it('counts every status, and the components of a deployment that are behind', () => {
		const deployment = {
			repo: 'site',
			url: 'https://example.org',
			components: { a: 'x', b: 'y' },
		};
		const { totals, deployments } = buildDriftReport({
			...result,
			deployments: [
				assessDeployment(
					deployment,
					{ a: '1.0.0', b: '2.0.0' },
					new Map([
						['x', release('1.1.0')],
						['y', release('2.0.0')],
					]),
				),
			],
		});
		expect(totals).toEqual({
			usages: 5,
			byStatus: { range: 2, 'stale-lock': 2, unknown: 0, ahead: 0, current: 1 },
			deploymentsBehind: 1,
			pinsBehind: 0,
		});
		expect(deployments).toHaveLength(1);
	});

	it('has no deployments when none were collected', () => {
		expect(buildDriftReport(result).deployments).toEqual([]);
	});

	it('leaves the findings it was given in their original order', () => {
		const before = result.findings.map((finding) => finding.consumer);
		buildDriftReport(result);
		expect(result.findings.map((finding) => finding.consumer)).toEqual(before);
	});

	it('survives being written to JSON, which a Map would not', () => {
		const report = buildDriftReport({
			...result,
			deployments: [
				assessDeployment(
					{ repo: 'site', url: 'https://example.org', components: { a: 'x' } },
					{ a: '1.0.0' },
					new Map([['x', release('1.1.0')]]),
				),
			],
		});
		expect(JSON.parse(JSON.stringify(report))).toEqual(report);
	});
});

describe('renderDrift', () => {
	const now = new Date('2026-09-28T00:00:00Z');

	it('shows the spread of versions and puts the worst first', () => {
		const findings = [
			assess(usage({ consumer: 'a', installed: '6.0.3' }), release('6.0.3')),
			assess(
				usage({ consumer: 'b', requested: '^5.0.0', installed: '5.0.0' }),
				release('6.0.3'),
			),
			assess(usage({ consumer: 'c', path: 'web/package.json' }), release('6.0.3')),
		];
		const report = renderDrift(
			{ findings, releases: new Map([['npm:@versatiles/style', release('6.0.3')]]) },
			{ color: false, now, onlyOutdated: false },
		);
		const lines = report.split('\n');
		expect(lines[0]).toBe('Packages and their dependents');
		expect(lines[3]).toBe('  6.0.3 ×1 · 6.0.1 ×1 · 5.0.0 ×1');
		expect(lines[4]).toMatch(/^ {2}✗ {2}b /);
		expect(lines[5]).toMatch(/^ {2}↑ {2}c\/web /);
		expect(lines[6]).toMatch(/^ {2}✓ {2}a /);
	});

	it('lists, per dependent, the packages it is behind on', () => {
		const style = release('6.0.3');
		const core = usage({ name: '@versatiles/core', provider: 'versatiles-core' });
		const findings = [
			assess(usage({ consumer: 'a', installed: '6.0.3' }), style),
			assess(usage({ consumer: 'b', path: 'web/package.json' }), style),
			assess(usage({ consumer: 'b', requested: '^5.0.0', installed: '5.0.0' }), style),
			assess({ ...core, consumer: 'b', section: 'devDependencies' }, release('6.1.0')),
			assess({ ...core, consumer: 'c', installed: '7.0.0' }, release('6.1.0')),
		];
		const releases = new Map([
			['npm:@versatiles/style', style],
			['npm:@versatiles/core', release('6.1.0')],
		]);
		const report = renderDrift(
			{ findings, releases },
			{ color: false, now, onlyOutdated: false },
		);
		const section = report.split('after the repositories it builds on\n\n')[1].split('\n');
		expect(section.slice(0, 5)).toEqual([
			'b  3 outdated',
			'  ✗  @versatiles/style         5.0.0 → 6.0.3  ^5.0.0       major behind, range excludes latest',
			'  ↑  @versatiles/core          6.0.1 → 6.1.0  ^6.0.1  dev  minor behind, range admits latest, lockfile is behind',
			'  ↑  @versatiles/style in web  6.0.1 → 6.0.3  ^6.0.1       patch behind, range admits latest, lockfile is behind',
			'',
		]);
		// a is current and c is ahead: neither has anything to update.
		expect(section[5]).toMatch(/^2 packages, 5 usages/);
	});

	it('can leave out packages that are fully current, and colours on request', () => {
		const findings = [assess(usage({ installed: '6.0.3' }), release('6.0.3'))];
		const result = { findings, releases: new Map([['npm:@versatiles/style', release('6.0.3')]]) };
		expect(renderDrift(result, { color: false, now, onlyOutdated: true })).toBe(
			'1 package, 1 usage: 1 current',
		);
		expect(renderDrift(result, { color: true, now, onlyOutdated: false })).toContain('\u001b[');
	});

	it('says how long ago a release was', () => {
		const at = (date: string): Release => ({ version: '6.0.3', date, source: 'registry' });
		const findings = [assess(usage({ installed: '6.0.3' }), release('6.0.3'))];
		const render = (date: string): string =>
			renderDrift(
				{ findings, releases: new Map([['npm:@versatiles/style', at(date)]]) },
				{ color: false, now, onlyOutdated: false },
			);
		expect(render('2026-09-28T00:00:00Z')).toContain('(today)');
		expect(render('2026-09-27T00:00:00Z')).toContain('(1 day ago)');
	});
});

describe('updateOrder', () => {
	const uses = (consumer: string, provider: string) => ({ consumer, provider });

	it('lists a repository after everything it builds on', () => {
		const usages = [
			uses('app', 'style'),
			uses('style', 'release-tool'),
			uses('app', 'container'),
		];
		expect(updateOrder(['app', 'container', 'release-tool', 'style'], usages)).toEqual([
			'container',
			'release-tool',
			'style',
			'app',
		]);
	});

	it('sees a dependency through a repository that is not in the list', () => {
		const usages = [uses('app', 'middle'), uses('middle', 'base')];
		expect(updateOrder(['app', 'base'], usages)).toEqual(['base', 'app']);
	});

	it('lets the rank decide between repositories that are independent', () => {
		const rank = (repo: string): number => ['helper', 'core', 'site'].indexOf(repo);
		expect(updateOrder(['core', 'site', 'helper'], [], rank)).toEqual(['helper', 'core', 'site']);
	});

	it('puts a dependency first even against the rank', () => {
		const rank = (repo: string): number => (repo === 'site' ? 0 : 1);
		expect(updateOrder(['site', 'core'], [uses('site', 'core')], rank)).toEqual(['core', 'site']);
	});

	it('still orders the rest when two repositories depend on each other', () => {
		const usages = [uses('a', 'b'), uses('b', 'a'), uses('c', 'a'), uses('a', 'base')];
		expect(updateOrder(['c', 'b', 'a', 'base'], usages)).toEqual(['base', 'a', 'b', 'c']);
	});
});

describe('deployments', () => {
	const deployment = {
		repo: 'tiles.versatiles.org',
		url: 'https://tiles.versatiles.org/version.json',
		components: {
			versatiles: 'versatiles-rs',
			frontend: 'versatiles-frontend',
			styles: 'versatiles-style',
		},
	};
	const release = (version: string, date: string | null = null): Release => ({
		version,
		date,
		source: 'release',
	});
	const latest = new Map([
		['versatiles-rs', release('v5.4.0')],
		['versatiles-frontend', release('v3.16.1', '2026-10-16T13:31:25Z')],
		['versatiles-style', release('v7.0.1')],
	]);
	const status = (body: unknown) =>
		Object.fromEntries(
			assessDeployment(deployment, body, latest).findings.map((finding) => [
				finding.component,
				`${finding.status} ${finding.behind ?? ''}`.trim(),
			]),
		);

	it('compares what runs with the latest release, with or without a v', () => {
		expect(
			status({
				versatiles: '5.4.0',
				frontend: 'v3.15.2',
				styles: 'v7.0.1',
				updated: '2026-10-18T22:18:58Z',
			}),
		).toEqual({ versatiles: 'current', frontend: 'behind minor', styles: 'current' });
	});

	it('reports what it cannot compare instead of leaving it out', () => {
		expect(status({ versatiles: '5.4.0', frontend: 'main', glyphs: '1.0.0' })).toEqual({
			versatiles: 'current',
			frontend: 'unknown',
			styles: 'unknown',
			glyphs: 'unknown',
		});
	});

	it('notes a deployment that is newer than any release', () => {
		expect(status({ versatiles: '5.5.0', frontend: '3.16.1', styles: '7.0.1' }).versatiles).toBe(
			'ahead',
		);
	});

	it('survives a deployment that cannot be reached', async () => {
		const reports = await collectDeployments(
			[deployment],
			{
				getRegistryJson: () => Promise.reject(new Error('down')),
				latestRelease: () => Promise.resolve(release('v1.0.0')),
			},
			mapLimit,
		);
		expect(reports[0]).toMatchObject({ reachable: false, findings: [] });
	});

	it('leaves one component unknown when its latest release cannot be read', async () => {
		const reports = await collectDeployments(
			[deployment],
			{
				getRegistryJson: () =>
					Promise.resolve({ versatiles: '5.4.0', frontend: '3.16.1', styles: '7.0.1' }),
				latestRelease: (repo) =>
					repo === 'versatiles-rs'
						? Promise.reject(new Error('502'))
						: Promise.resolve(release(repo === 'versatiles-style' ? 'v7.0.1' : 'v3.16.1')),
			},
			mapLimit,
		);
		expect(
			Object.fromEntries(
				reports[0].findings.map((finding) => [finding.component, finding.status]),
			),
		).toEqual({ versatiles: 'unknown', frontend: 'current', styles: 'current' });
	});

	it('asks each repository for its latest release once', async () => {
		const asked: string[] = [];
		await collectDeployments(
			[deployment, { ...deployment, repo: 'mirror' }],
			{
				getRegistryJson: () => Promise.resolve({}),
				latestRelease: (repo) => {
					asked.push(repo);
					return Promise.resolve(null);
				},
			},
			mapLimit,
		);
		expect(asked.sort()).toEqual(['versatiles-frontend', 'versatiles-rs', 'versatiles-style']);
	});

	it('lists the deployments after the packages, and counts what needs a redeploy', () => {
		const report = renderDrift(
			{
				findings: [],
				releases: new Map(),
				deployments: [
					assessDeployment(
						deployment,
						{
							versatiles: '5.4.0',
							frontend: 'v3.15.2',
							styles: 'v7.0.1',
							updated: '2026-10-18T22:18:58Z',
						},
						latest,
					),
				],
			},
			{ color: false, now: new Date('2026-10-19T12:00:00Z'), onlyOutdated: false },
		);
		expect(report).toContain('Deployments');
		expect(report).toContain(
			'tiles.versatiles.org  https://tiles.versatiles.org/version.json · updated 2026-10-18 (today)',
		);
		expect(report).toMatch(
			/↑ {2}frontend {4}3\.15\.2 → 3\.16\.1 {2}versatiles-frontend {2}minor behind, redeploy, released 2026-10-16/,
		);
		expect(report).toMatch(/✓ {2}versatiles {2}5\.4\.0/);
		expect(report).toMatch(/1 deployed behind$/);
	});

	it('leaves out a deployment that is current when asked for what is outdated', () => {
		const current = assessDeployment(
			deployment,
			{ versatiles: '5.4.0', frontend: '3.16.1', styles: '7.0.1' },
			latest,
		);
		const report = renderDrift(
			{ findings: [], releases: new Map(), deployments: [current] },
			{ color: false, now: new Date(), onlyOutdated: true },
		);
		expect(report).not.toContain('Deployments');
	});
});
