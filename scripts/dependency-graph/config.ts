/**
 * Editorial input for the dependency graph.
 *
 * Everything a parser cannot know — what a repository is for, which Docker
 * image is built by which repository, which findings are noise — lives in
 * `scripts/dependency-graph.yaml` so the code stays free of special cases.
 */

import { readFileSync } from 'fs';
import type { Bundle, Deployment, Pin, PinnedImage } from './drift';
import { resolve } from 'path';
import { load as loadYaml } from 'js-yaml';
import { EDGE_KINDS, type EdgeKind, type TagInfo } from './model';

export interface ManualEdgeConfig {
	from: string;
	to: string;
	kind: EdgeKind;
	note: string;
}

export interface IgnoreConfig {
	from: string;
	to: string;
	/** Restricts the rule to one kind; omit to drop the pair entirely. */
	kind?: EdgeKind;
	reason: string;
}

export interface GraphConfig {
	org: string;
	includeArchived: boolean;
	includeForks: boolean;
	/** The vocabulary, in the order tags are presented. */
	tags: TagInfo[];
	/** Repository name to its tags, most characteristic first. */
	repositories: Record<string, string[]>;
	/** Services that publish which releases they run, for the drift report. */
	deployments: Deployment[];
	/** Files that name an exact release of another repository, for the drift report. */
	pins: Pin[];
	/** Images tagged with the release of another repository, for the drift report. */
	pinnedImages: PinnedImage[];
	/** Releases whose notes list what they bundle, for the drift report. */
	bundles: Bundle[];
	/** Tag ids in the order their repositories should be updated; see the drift report. */
	updateOrder: string[];
	/** Docker image name (without tag) to the repository that builds it. */
	images: Record<string, string>;
	/** Repositories left out of the graph entirely. */
	exclude: string[];
	manual: ManualEdgeConfig[];
	ignore: IgnoreConfig[];
}

export const CONFIG_PATH = 'scripts/dependency-graph.yaml';

function fail(message: string): never {
	throw new Error(`${CONFIG_PATH}: ${message}`);
}

function asEdgeKind(value: unknown, where: string): EdgeKind {
	if (typeof value !== 'string' || !(EDGE_KINDS as readonly string[]).includes(value)) {
		fail(`${where} has kind ${JSON.stringify(value)}, expected one of ${EDGE_KINDS.join(', ')}`);
	}
	return value as EdgeKind;
}

function asString(value: unknown, where: string): string {
	if (typeof value !== 'string' || value === '') fail(`${where} must be a non-empty string`);
	return value;
}

export function loadConfig(root: string): GraphConfig {
	const raw = loadYaml(readFileSync(resolve(root, CONFIG_PATH), 'utf8'));
	if (typeof raw !== 'object' || raw === null) fail('expected a mapping at the top level');
	const doc = raw as Record<string, unknown>;

	const tags = ((doc.tags as unknown[] | undefined) ?? []).map((entry, index) => {
		const tag = entry as Record<string, unknown>;
		if (tag.hue !== undefined && (typeof tag.hue !== 'number' || tag.hue < 0 || tag.hue >= 360)) {
			fail(`tags[${index}].hue must be a number from 0 up to 360`);
		}
		return {
			id: asString(tag.id, `tags[${index}].id`),
			title: asString(tag.title, `tags[${index}].title`),
			summary: asString(tag.summary, `tags[${index}].summary`),
			// Left out entirely when unset, so the generated JSON carries no nulls.
			...(tag.hue === undefined ? {} : { hue: tag.hue }),
		};
	});
	if (tags.length === 0) fail('at least one tag has to be defined');

	const known = new Set(tags.map((tag) => tag.id));
	const repositories: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(
		(doc.repositories as Record<string, unknown> | undefined) ?? {},
	)) {
		if (!Array.isArray(value) || value.length === 0) {
			fail(`repositories.${name} must be a non-empty list of tags`);
		}
		repositories[name] = value.map((tag, index) => {
			const id = asString(tag, `repositories.${name}[${index}]`);
			if (!known.has(id)) fail(`repositories.${name} uses undefined tag "${id}"`);
			return id;
		});
	}

	// Tags the list leaves out follow in the order the vocabulary has them.
	const updateOrder = ((doc.update_order as unknown[] | undefined) ?? []).map((tag, index) => {
		const id = asString(tag, `update_order[${index}]`);
		if (!known.has(id)) fail(`update_order uses undefined tag "${id}"`);
		return id;
	});
	for (const tag of tags) if (!updateOrder.includes(tag.id)) updateOrder.push(tag.id);

	const deployments = ((doc.deployments as unknown[] | undefined) ?? []).map((entry, index) => {
		const where = `deployments[${index}]`;
		const deployment = entry as Record<string, unknown>;
		const components = deployment.components;
		if (typeof components !== 'object' || components === null || Array.isArray(components)) {
			fail(`${where}.components must map component names to repositories`);
		}
		return {
			repo: asString(deployment.repo, `${where}.repo`),
			url: asString(deployment.url, `${where}.url`),
			components: Object.fromEntries(
				Object.entries(components).map(([name, repo]) => [
					name,
					asString(repo, `${where}.components.${name}`),
				]),
			),
		};
	});

	const pins = ((doc.pins as unknown[] | undefined) ?? []).map((entry, index): Pin => {
		const where = `pins[${index}]`;
		const pin = entry as Record<string, unknown>;
		if ((pin.pattern === undefined) === (pin.json === undefined)) {
			fail(`${where} needs either a pattern or a json path, and not both`);
		}
		const base = {
			repo: asString(pin.repo, `${where}.repo`),
			path: asString(pin.path, `${where}.path`),
			provider: asString(pin.provider, `${where}.provider`),
		};
		if (pin.json !== undefined) return { ...base, json: asString(pin.json, `${where}.json`) };
		const pattern = asString(pin.pattern, `${where}.pattern`);
		// One group is what the code reads the version from; a mistake should show here, not at runtime.
		let groups: number;
		try {
			groups = new RegExp(`${pattern}|`).exec('')!.length - 1;
		} catch {
			fail(`${where}.pattern is not a valid regular expression`);
		}
		if (groups < 1) fail(`${where}.pattern needs a group around the version`);
		return { ...base, pattern };
	});

	const pinnedImages = ((doc.pinned_images as unknown[] | undefined) ?? []).map(
		(entry, index): PinnedImage => {
			const where = `pinned_images[${index}]`;
			const image = entry as Record<string, unknown>;
			return {
				image: asString(image.image, `${where}.image`),
				repo: asString(image.repo, `${where}.repo`),
				provider: asString(image.provider, `${where}.provider`),
			};
		},
	);

	const bundles = ((doc.bundles as unknown[] | undefined) ?? []).map((entry, index): Bundle => {
		const where = `bundles[${index}]`;
		const bundle = entry as Record<string, unknown>;
		const { components, ignore } = bundle;
		if (typeof components !== 'object' || components === null || Array.isArray(components)) {
			fail(`${where}.components must map names in the release notes to repositories`);
		}
		if (ignore !== undefined && !Array.isArray(ignore)) {
			fail(`${where}.ignore must be a list of names in the release notes`);
		}
		return {
			repo: asString(bundle.repo, `${where}.repo`),
			components: Object.fromEntries(
				Object.entries(components).map(([name, repo]) => [
					name,
					asString(repo, `${where}.components.${name}`),
				]),
			),
			ignore: ((ignore as unknown[] | undefined) ?? []).map((name, at) =>
				asString(name, `${where}.ignore[${at}]`),
			),
		};
	});

	const manual = (doc.manual as unknown[] | undefined) ?? [];
	const ignore = (doc.ignore as unknown[] | undefined) ?? [];

	return {
		org: asString(doc.org, 'org'),
		includeArchived: doc.include_archived === true,
		includeForks: doc.include_forks !== false,
		tags,
		repositories,
		deployments,
		pins,
		pinnedImages,
		bundles,
		updateOrder,
		images: (doc.images as Record<string, string> | undefined) ?? {},
		exclude: (doc.exclude as string[] | undefined) ?? [],
		manual: manual.map((entry, index) => {
			const edge = entry as Record<string, unknown>;
			return {
				from: asString(edge.from, `manual[${index}].from`),
				to: asString(edge.to, `manual[${index}].to`),
				kind: asEdgeKind(edge.kind, `manual[${index}]`),
				note: asString(edge.note, `manual[${index}].note`),
			};
		}),
		ignore: ignore.map((entry, index) => {
			const rule = entry as Record<string, unknown>;
			return {
				from: asString(rule.from, `ignore[${index}].from`),
				to: asString(rule.to, `ignore[${index}].to`),
				kind: rule.kind === undefined ? undefined : asEdgeKind(rule.kind, `ignore[${index}]`),
				reason: asString(rule.reason, `ignore[${index}].reason`),
			};
		}),
	};
}

/**
 * Reports config entries that no longer match reality. Repositories get
 * renamed and archived; without this the configuration quietly rots.
 */
export function validateConfig(config: GraphConfig, knownRepos: Set<string>): string[] {
	const problems: string[] = [];

	const checkRepo = (name: string, where: string): void => {
		if (!knownRepos.has(name)) problems.push(`${where}: unknown repository "${name}"`);
	};

	const seenTags = new Set<string>();
	for (const tag of config.tags) {
		if (seenTags.has(tag.id)) problems.push(`tags: "${tag.id}" is defined twice`);
		seenTags.add(tag.id);
	}

	for (const [name, tags] of Object.entries(config.repositories)) {
		checkRepo(name, 'repositories');
		if (new Set(tags).size !== tags.length) {
			problems.push(`repositories.${name} repeats a tag`);
		}
	}
	for (const deployment of config.deployments) {
		checkRepo(deployment.repo, 'deployments');
		for (const repo of Object.values(deployment.components)) checkRepo(repo, 'deployments');
	}

	for (const pin of [...config.pins, ...config.pinnedImages]) {
		checkRepo(pin.repo, 'pins');
		checkRepo(pin.provider, 'pins');
	}

	for (const bundle of config.bundles) {
		checkRepo(bundle.repo, 'bundles');
		for (const repo of Object.values(bundle.components)) checkRepo(repo, 'bundles');
	}

	for (const repo of config.exclude) checkRepo(repo, 'exclude');
	for (const image of Object.values(config.images)) checkRepo(image, 'images');
	for (const edge of config.manual) {
		checkRepo(edge.from, 'manual');
		checkRepo(edge.to, 'manual');
	}
	for (const rule of config.ignore) {
		checkRepo(rule.from, 'ignore');
		checkRepo(rule.to, 'ignore');
	}
	return problems;
}
