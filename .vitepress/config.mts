import { defineConfig } from 'vitepress';

const BASE = '/dependency-graph/';
const SITE_URL = `https://versatiles.org${BASE}`;
const SITE_TITLE = 'VersaTiles Dependency Graph';
const SITE_DESCRIPTION = 'How the VersaTiles repositories build on each other.';

export default defineConfig({
	title: SITE_TITLE,
	description: SITE_DESCRIPTION,
	// Served as a project site below versatiles.org, not from a domain root.
	base: BASE,
	srcExclude: ['README.md'],
	vite: {
		build: {
			target: 'esnext',
		},
		optimizeDeps: {
			esbuildOptions: {
				target: 'esnext',
			},
		},
	},
	// VitePress does not apply `base` to head entries, so these carry it themselves.
	head: [
		['link', { rel: 'canonical', href: SITE_URL }],
		[
			'link',
			{
				rel: 'shortcut icon',
				sizes: '16x16 24x24 32x32 48x48 64x64',
				href: `${BASE}favicon.ico`,
			},
		],
		[
			'link',
			{ rel: 'icon', type: 'image/png', href: `${BASE}versatiles.32.png`, sizes: '32x32' },
		],
		[
			'link',
			{ rel: 'icon', type: 'image/png', href: `${BASE}versatiles.48.png`, sizes: '48x48' },
		],
		[
			'link',
			{ rel: 'icon', type: 'image/png', href: `${BASE}versatiles.64.png`, sizes: '64x64' },
		],
		[
			'link',
			{ rel: 'icon', type: 'image/png', href: `${BASE}versatiles.96.png`, sizes: '96x96' },
		],
		['meta', { name: 'twitter:card', content: 'summary_large_image' }],
		['meta', { property: 'og:type', content: 'website' }],
		['meta', { property: 'og:site_name', content: 'VersaTiles' }],
		['meta', { property: 'og:url', content: SITE_URL }],
		['meta', { property: 'og:title', content: SITE_TITLE }],
		['meta', { property: 'og:description', content: SITE_DESCRIPTION }],
		['meta', { property: 'og:image', content: `${SITE_URL}versatiles-social.png` }],
		['meta', { property: 'og:image:type', content: 'image/png' }],
		['meta', { property: 'og:image:width', content: '1200' }],
		['meta', { property: 'og:image:height', content: '675' }],
		['meta', { property: 'og:image:alt', content: 'versatiles logo on a gradient background' }],
	],
	themeConfig: {
		logo: '/versatiles.svg',
		logoLink: 'https://versatiles.org',
		nav: [
			{ text: 'Website', link: 'https://versatiles.org' },
			{ text: 'Documentation', link: 'https://docs.versatiles.org' },
		],
		socialLinks: [{ icon: 'github', link: 'https://github.com/versatiles-org/dependency-graph' }],
		footer: {
			message: 'Released under Unlicense',
		},
	},
});
