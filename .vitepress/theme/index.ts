// https://vitepress.dev/guide/custom-theme
import { inBrowser, type Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
// Variable, so version numbers can be light, regular and bold on every system.
import '@fontsource-variable/jetbrains-mono';
import './style.css';
import DependencyGraph from './components/DependencyGraph.vue';
import IssuesPage from './components/IssuesPage.vue';
import StatusPage from './components/StatusPage.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		// In production Vue only logs a render error, so a page that crashes while
		// being built would still pass the build and get deployed. Fail it instead.
		if (!inBrowser) app.config.throwUnhandledErrorInProduction = true;

		app.component('DependencyGraph', DependencyGraph);
		app.component('StatusPage', StatusPage);
		app.component('IssuesPage', IssuesPage);
	},
} satisfies Theme;
