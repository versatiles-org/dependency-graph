<script setup lang="ts">
/**
 * `1.4.2 → 2.0.0`: the version in use in light, the latest in regular with the
 * number that changed in bold, so the size of the step reads without colour.
 */
import { computed } from 'vue';
import { splitVersion } from '../../../scripts/dependency-graph/status-view';

const props = defineProps<{
	installed: string | null;
	latest: string | null;
	behind: 'major' | 'minor' | 'patch' | null;
}>();

const latest = computed(() => splitVersion(props.latest ?? '?', props.behind));
</script>

<template>
	<span class="version-change"
		><span class="installed">{{ installed ?? '—' }}</span> →
		<span class="latest"
			>{{ latest.before }}<b>{{ latest.changed }}</b
			>{{ latest.after }}</span
		></span
	>
</template>

<style scoped>
.version-change {
	font-family: var(--vp-font-family-mono);
	font-size: 13px;
}

.installed {
	color: var(--vp-c-text-2);
	font-weight: 300;
}

.latest {
	font-weight: 400;

	b {
		font-weight: 700;
	}
}
</style>
