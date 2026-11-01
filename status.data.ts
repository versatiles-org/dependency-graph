/**
 * Feeds the status page from the snapshot `npm run sync:deps` writes. The file
 * is not committed, so a build without it is normal: pull requests have none,
 * and neither has a fresh checkout. The page then says so.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineLoader } from 'vitepress';
import { readStatusSnapshot, type StatusSnapshot } from './scripts/dependency-graph/status';

declare const data: StatusSnapshot | null;
export { data };

export default defineLoader({
	watch: ['./public/status.json'],
	load(): StatusSnapshot | null {
		const path = resolve(dirname(fileURLToPath(import.meta.url)), './public/status.json');
		if (!existsSync(path)) return null;

		const snapshot = readStatusSnapshot(readFileSync(path, 'utf8'));
		if (snapshot) return snapshot;

		// Left over on a laptop this is harmless, and no reason to fail an offline check.
		// In CI the same code has only just written it, so it can only be a bug.
		const problem = 'public/status.json does not match this version of the code';
		if (process.env.CI) throw new Error(problem);
		console.warn(
			`[status] ${problem}, so it is ignored. Run \`npm run sync:deps\` to replace it.`,
		);
		return null;
	},
});
