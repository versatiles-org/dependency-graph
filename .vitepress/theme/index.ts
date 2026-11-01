// https://vitepress.dev/guide/custom-theme
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import './style.css';
import DependencyGraph from './components/DependencyGraph.vue';
import StatusPage from './components/StatusPage.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		app.component('DependencyGraph', DependencyGraph);
		app.component('StatusPage', StatusPage);
	},
} satisfies Theme;
