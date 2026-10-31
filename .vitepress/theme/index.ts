// https://vitepress.dev/guide/custom-theme
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import './style.css';
import DependencyGraph from './components/DependencyGraph.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		app.component('DependencyGraph', DependencyGraph);
	},
} satisfies Theme;
