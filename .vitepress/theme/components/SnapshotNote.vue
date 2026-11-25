<script setup lang="ts">
/** When the data on a status page was collected, and whether updates still run. */
import { computed, onMounted, ref } from 'vue';
import { formatTime, hoursAgo, isStale } from '../../../scripts/dependency-graph/status-view';

const props = defineProps<{ generatedAt: string }>();

/** Unknown until mounted: the server must not bake an age into the page. */
const now = ref<Date | null>(null);
onMounted(() => {
	now.value = new Date();
});

const age = computed(() => (now.value ? hoursAgo(props.generatedAt, now.value) : null));
const stale = computed(() => Boolean(now.value && isStale(props.generatedAt, now.value)));
</script>

<template>
	<p class="snapshot" :class="{ stale }">
		Data from {{ formatTime(generatedAt) }} <template v-if="age">({{ age }})</template
		><template v-if="stale"
			>. Updates should run at least every six hours, so they may have stopped.</template
		><template v-else
			>. Updated within ten minutes of a change, and at least every six hours.</template
		>
	</p>
</template>
