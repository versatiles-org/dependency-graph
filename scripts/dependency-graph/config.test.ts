import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { CONFIG_PATH, loadConfig, validateConfig, type GraphConfig } from './config';

/** Writes a configuration into a throwaway directory and loads it back. */
function load(yaml: string): GraphConfig {
	const root = mkdtempSync(resolve(tmpdir(), 'dependency-graph-'));
	mkdirSync(resolve(root, 'scripts'), { recursive: true });
	writeFileSync(resolve(root, CONFIG_PATH), yaml);
	return loadConfig(root);
}

const MINIMAL = `
org: versatiles-org
tags:
  - id: library
    title: Libraries
    summary: Code to build on.
repositories:
  'versatiles-rs': [library]
`;

describe('loadConfig', () => {
	it('reads the vocabulary and the repositories', () => {
		const config = load(MINIMAL);
		expect(config.org).toBe('versatiles-org');
		expect(config.tags).toEqual([
			{ id: 'library', title: 'Libraries', summary: 'Code to build on.' },
		]);
		expect(config.repositories['versatiles-rs']).toEqual(['library']);
	});

	it('keeps archived repositories out and forks in, unless told otherwise', () => {
		expect(load(MINIMAL).includeArchived).toBe(false);
		expect(load(MINIMAL).includeForks).toBe(true);
		expect(load(`${MINIMAL}\ninclude_archived: true\ninclude_forks: false\n`)).toMatchObject({
			includeArchived: true,
			includeForks: false,
		});
	});

	it('refuses a tag no repository could mean', () => {
		expect(() => load(`${MINIMAL.replace('[library]', '[libary]')}`)).toThrow(/undefined tag/);
	});

	it('refuses a repository with no tags at all', () => {
		expect(() => load(MINIMAL.replace('[library]', '[]'))).toThrow(/non-empty list/);
	});

	it('refuses a configuration with no vocabulary', () => {
		expect(() => load('org: versatiles-org\n')).toThrow(/at least one tag/);
	});

	it('names the field that is wrong', () => {
		expect(() => load(MINIMAL.replace('title: Libraries', 'title: 7'))).toThrow(
			/tags\[0\].title/,
		);
	});

	it('takes the hue a tag is drawn in, and leaves it out when there is none', () => {
		const withHue = MINIMAL.replace('title: Libraries', 'title: Libraries\n    hue: 25');
		expect(load(withHue).tags[0]).toMatchObject({ hue: 25 });
		expect(load(MINIMAL).tags[0]).not.toHaveProperty('hue');
	});

	it('orders updates as told, and appends the tags the list leaves out', () => {
		const two = `${MINIMAL.replace('repositories:', '  - id: helper\n    title: Helpers\n    summary: Internal.\nrepositories:')}`;
		expect(load(two).updateOrder).toEqual(['library', 'helper']);
		expect(load(`${two}\nupdate_order: [helper]\n`).updateOrder).toEqual(['helper', 'library']);
		expect(() => load(`${two}\nupdate_order: [nope]\n`)).toThrow(
			/update_order uses undefined tag/,
		);
	});

	it('reads the tooling packages, and has none unless told', () => {
		expect(load(MINIMAL).tooling).toEqual([]);
		expect(load(`${MINIMAL}\ntooling: ['@versatiles/release-tool']\n`).tooling).toEqual([
			'@versatiles/release-tool',
		]);
		expect(() => load(`${MINIMAL}\ntooling: '@versatiles/release-tool'\n`)).toThrow(
			/tooling must be a list/,
		);
	});

	it('refuses a hue that is not an angle', () => {
		const withHue = (hue: string) =>
			MINIMAL.replace('title: Libraries', `title: Libraries\n    hue: ${hue}`);
		expect(() => load(withHue('red'))).toThrow(/tags\[0\].hue/);
		expect(() => load(withHue('360'))).toThrow(/tags\[0\].hue/);
	});
});

describe('pins in the configuration', () => {
	const pin = (fields: string): string =>
		`${MINIMAL}pins:\n  - { repo: a, path: b, provider: c, ${fields} }\n`;

	it('reads a pattern or a json path, and images', () => {
		const config = load(
			`${pin(`pattern: 'v([0-9.]+)'`)}pinned_images:\n  - { image: x/y, repo: a, provider: c }\n`,
		);
		expect(config.pins).toEqual([{ repo: 'a', path: 'b', provider: 'c', pattern: 'v([0-9.]+)' }]);
		expect(config.pinnedImages).toEqual([{ image: 'x/y', repo: 'a', provider: 'c' }]);
		expect(load(pin('json: x.y')).pins[0].json).toBe('x.y');
	});

	it('has none unless told', () => {
		expect(load(MINIMAL)).toMatchObject({ pins: [], pinnedImages: [] });
	});

	it('wants exactly one way of finding the version', () => {
		expect(() => load(pin(`pattern: '(x)', json: y`))).toThrow(/either a pattern or a json/);
		expect(() => load(`${MINIMAL}pins:\n  - { repo: a, path: b, provider: c }\n`)).toThrow(
			/either a pattern or a json/,
		);
	});

	it('refuses a pattern that could never yield a version', () => {
		expect(() => load(pin(`pattern: 'version'`))).toThrow(/group around the version/);
		expect(() => load(pin(`pattern: '('`))).toThrow(/not a valid regular expression/);
	});

	it('reports a repository that no longer exists', () => {
		const config = load(
			`${pin(`json: x`)}pinned_images:\n  - { image: x/y, repo: gone, provider: versatiles-rs }\n`,
		);
		const known = new Set(['versatiles-rs', 'a']);
		expect(validateConfig(config, known)).toEqual([
			'pins: unknown repository "c"',
			'pins: unknown repository "gone"',
		]);
	});
});

describe('bundles in the configuration', () => {
	const BUNDLE = `${MINIMAL}bundles:
  - repo: versatiles-frontend
    components:
      VersaTiles Style: versatiles-style
    ignore: [MapLibre GL JS]
`;

	it('reads the components and what is knowingly left out', () => {
		expect(load(BUNDLE).bundles).toEqual([
			{
				repo: 'versatiles-frontend',
				components: { 'VersaTiles Style': 'versatiles-style' },
				ignore: ['MapLibre GL JS'],
			},
		]);
		expect(load(MINIMAL).bundles).toEqual([]);
	});

	it('refuses components that are not a mapping', () => {
		expect(() => load(`${MINIMAL}bundles:\n  - { repo: a, components: [b] }\n`)).toThrow(
			/components must map/,
		);
	});

	it('reports a repository that no longer exists', () => {
		expect(validateConfig(load(BUNDLE), new Set(['versatiles-rs']))).toEqual([
			'bundles: unknown repository "versatiles-frontend"',
			'bundles: unknown repository "versatiles-style"',
		]);
	});
});

describe('validateConfig', () => {
	const known = new Set(['versatiles-rs', 'versatiles-docker']);

	it('passes a configuration that matches the organisation', () => {
		expect(validateConfig(load(MINIMAL), known)).toEqual([]);
	});

	it('catches a repository that no longer exists, wherever it is named', () => {
		const config = load(`${MINIMAL}
exclude: ['gone-one']
images:
  versatiles/versatiles: gone-two
manual:
  - from: gone-three
    to: versatiles-rs
    kind: manual
    note: historic
ignore:
  - from: versatiles-rs
    to: gone-four
    reason: noise
`);
		const problems = validateConfig(config, known).join('\\n');
		for (const name of ['gone-one', 'gone-two', 'gone-three', 'gone-four']) {
			expect(problems).toContain(name);
		}
	});

	it('catches a repository listed under a renamed name', () => {
		const config = load(MINIMAL.replace("'versatiles-rs'", "'versatiles-rust'"));
		expect(validateConfig(config, known)).toEqual([
			'repositories: unknown repository "versatiles-rust"',
		]);
	});

	it('catches a tag defined twice, and a tag repeated on one repository', () => {
		const config = load(`
org: versatiles-org
tags:
  - id: library
    title: Libraries
    summary: Code to build on.
  - id: library
    title: Duplicate
    summary: Same id again.
repositories:
  'versatiles-rs': [library, library]
`);
		const problems = validateConfig(config, known);
		expect(problems).toContain('tags: "library" is defined twice');
		expect(problems).toContain('repositories.versatiles-rs repeats a tag');
	});

	it('collects every problem rather than stopping at the first', () => {
		const config = load(
			MINIMAL.replace("'versatiles-rs'", "'gone'") + "\nexclude: ['also-gone']\n",
		);
		expect(validateConfig(config, known)).toHaveLength(2);
	});
});
