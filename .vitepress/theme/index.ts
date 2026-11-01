// https://vitepress.dev/guide/custom-theme
import { inBrowser, type Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import './style.css';
import DependencyGraph from './components/DependencyGraph.vue';
import StatusPage from './components/StatusPage.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		// In production Vue only logs a render error, so a page that crashes while
		// being built would still pass the build and get deployed. Fail it instead.
		if (!inBrowser) app.config.throwUnhandledErrorInProduction = true;

		app.component('DependencyGraph', DependencyGraph);
		app.component('StatusPage', StatusPage);
	},
} satisfies Theme;
