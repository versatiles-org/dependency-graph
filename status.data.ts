/**
 * Feeds the status page from the snapshot `npm run sync:deps` writes. The file
 * is not committed, so a build without it is normal: pull requests have none,
 * and neither has a fresh checkout. The page then says so.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineLoader } from 'vitepress';
import type { StatusSnapshot } from './scripts/dependency-graph/status';

declare const data: StatusSnapshot | null;
export { data };

export default defineLoader({
	watch: ['./public/status.json'],
	load(): StatusSnapshot | null {
		const path = resolve(dirname(fileURLToPath(import.meta.url)), './public/status.json');
		return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as StatusSnapshot) : null;
	},
});
