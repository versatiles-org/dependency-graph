<script setup lang="ts">
/**
 * The row of tabs at the top of a status page. The hash picks the tab, both on
 * arrival and when a link on the page changes it.
 */
import { onBeforeUnmount, onMounted } from 'vue';
import type { Tab } from './tabs';

const props = defineProps<{ tabs: Tab[]; label: string }>();
const selected = defineModel<string>({ required: true });

const isTab = (id: string): boolean => props.tabs.some((tab) => tab.id === id);
const showHash = (): void => {
	const id = decodeURIComponent(window.location.hash.slice(1));
	if (isTab(id)) selected.value = id;
};
onMounted(() => {
	showHash();
	window.addEventListener('hashchange', showHash);
});
onBeforeUnmount(() => window.removeEventListener('hashchange', showHash));

/** Replaced rather than pushed: a new entry would make VitePress reload the page on back. */
function select(id: string): void {
	selected.value = id;
	history.replaceState(history.state, '', `#${id}`);
}

/** Arrow keys, Home and End move between tabs, as in the ARIA tabs pattern. */
function onTabKey(event: KeyboardEvent): void {
	const ids = props.tabs.map((tab) => tab.id);
	const index = ids.indexOf(selected.value);
	const moves: Record<string, number> = {
		ArrowLeft: index - 1,
		ArrowRight: index + 1,
		Home: 0,
		End: ids.length - 1,
	};
	if (!(event.key in moves)) return;
	event.preventDefault();
	const id = ids[(moves[event.key] + ids.length) % ids.length];
	select(id);
	document.getElementById(id)?.focus();
}
</script>

<template>
	<div class="tabs" role="tablist" :aria-label="label" @keydown="onTabKey">
		<button
			v-for="tab in tabs"
			:id="tab.id"
			:key="tab.id"
			type="button"
			role="tab"
			class="tab"
			:class="{ selected: selected === tab.id }"
			:aria-selected="selected === tab.id"
			:aria-controls="`${tab.id}-panel`"
			:tabindex="selected === tab.id ? 0 : -1"
			@click="select(tab.id)"
		>
			{{ tab.label }}
			<span
				v-if="tab.count !== null"
				class="badge"
				:class="tab.count > 0 ? `is-${tab.tone}` : 'is-zero'"
				:title="`${tab.count} ${tab.counted}`"
				>{{ tab.count }}<span class="visually-hidden"> {{ tab.counted }}</span></span
			>
		</button>
	</div>
</template>

<style scoped src="./status-shared.css"></style>

<style scoped>
.tabs {
	display: flex;
	gap: 4px;
	margin-top: 24px;
	overflow-x: auto;
	/*
	 * A shadow rather than a border: the selected tab's line covers it without a
	 * negative margin, which would make the row scroll vertically.
	 */
	box-shadow: inset 0 -1px var(--vp-c-divider);
}

.tab {
	/*
	 * Holds the visually hidden text of the badge, which VitePress positions
	 * absolutely. Without this it would escape the scrolling row and widen the
	 * whole page on a phone.
	 */
	position: relative;
	display: inline-flex;
	flex: none;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	border-bottom: 2px solid transparent;
	color: var(--vp-c-text-2);
	font-weight: 500;
	white-space: nowrap;
	/* Clear of the fixed navigation bar when a link leads to a tab. */
	scroll-margin-top: 80px;

	&:hover {
		color: var(--vp-c-text-1);
	}

	&.selected {
		border-bottom-color: var(--vp-c-brand-1);
		color: var(--vp-c-text-1);
	}

	/* The row scrolls, so an outline outside the tab would be cut off. */
	&:focus-visible {
		outline-offset: -2px;
	}
}

.badge {
	min-width: 20px;
	padding: 0 6px;
	border-radius: 10px;
	background: color-mix(in srgb, var(--st-color) 16%, transparent);
	color: var(--st-color);
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	font-weight: 600;
	line-height: 18px;
	text-align: center;

	&.is-zero {
		background: var(--vp-c-default-soft);
		color: var(--vp-c-text-2);
	}
}
</style>
