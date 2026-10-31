/** Module shims for the non-TS assets the theme imports; Vite resolves these at build time. */

declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent;
	export default component;
}

declare module '*.css';
