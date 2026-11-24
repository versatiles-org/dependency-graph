<script setup lang="ts">
/**
 * How far a version is behind, as a circle filled like the dot its line starts
 * at in the graph: empty for a patch, half for a minor, full for a major
 * release. It takes the colour of the text around it.
 */
defineProps<{ step: 'major' | 'minor' | 'patch' }>();
</script>

<template>
	<svg class="step-icon" width="11" height="11" viewBox="-6 -6 12 12" aria-hidden="true">
		<circle r="4.5" :class="{ filled: step === 'major' }" />
		<path v-if="step === 'minor'" d="M 0 -4.5 A 4.5 4.5 0 0 1 0 4.5 Z" />
	</svg>
</template>

<style scoped>
.step-icon {
	flex: none;
	align-self: center;
	overflow: visible;
}

circle {
	fill: none;
	stroke: currentColor;
	stroke-width: 1.5;

	&.filled {
		fill: currentColor;
	}
}

path {
	fill: currentColor;
}
</style>
