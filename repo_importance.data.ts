/**
 * Feeds the issues page the repositories in order of how much they matter, so
 * it can list the open issues of the core before those of the helpers.
 *
 * It reads `public/dependency-graph.json`, which `npm run sync:deps` writes next
 * to the status snapshot in every run. Without it the list is empty and the page
 * orders repositories by name.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineLoader } from 'vitepress';
import { repoImportance, type Graph, type RepoImportance } from './scripts/dependency-graph/model';

declare const data: RepoImportance[];
export { data };

export default defineLoader({
	watch: ['./public/dependency-graph.json'],
	load(): RepoImportance[] {
		const path = resolve(
			dirname(fileURLToPath(import.meta.url)),
			'./public/dependency-graph.json',
		);
		if (!existsSync(path)) return [];
		return repoImportance(JSON.parse(readFileSync(path, 'utf8')) as Graph);
	},
});
