<script setup lang="ts">
/** One issue in a tree of blocking issues, and below it the issues that wait for it. */
import type { BlockNode } from '../../../scripts/dependency-graph/issues-view';
import { refUrl, shortRef } from '../../../scripts/dependency-graph/issues-view';

defineOptions({ name: 'BlockTree' });
defineProps<{ node: BlockNode; org: string }>();
</script>

<template>
	<li>
		<span class="node">
			<a class="mono ref" :href="node.item?.url ?? refUrl(node.ref)">{{
				shortRef(node.ref, org)
			}}</a>
			<template v-if="node.item">{{ node.item.title }}</template>
			<span v-else class="dim">not in this snapshot</span>
			<span v-if="node.cycle" class="dim"> (waits for itself through the issues above)</span>
			<span v-if="node.alsoWaitsFor.length > 0" class="dim also">
				also waits for
				<template
					v-for="(blocker, index) in node.alsoWaitsFor"
					:key="`${blocker.repo}#${blocker.number}`"
					><template v-if="index > 0">, </template
					><a class="mono" :href="refUrl(blocker)">{{ shortRef(blocker, org) }}</a></template
				>
			</span>
		</span>
		<ul v-if="node.blocks.length > 0">
			<BlockTree
				v-for="child in node.blocks"
				:key="`${child.ref.repo}#${child.ref.number}`"
				:node="child"
				:org="org"
			/>
		</ul>
	</li>
</template>

<style scoped src="./status-shared.css"></style>

<style scoped>
/*
 * Each level hangs off a line from its parent: the issue at the top blocks the
 * ones below it.
 */
ul {
	margin: 0;
	padding-left: 22px;
	list-style: none;
}

li {
	position: relative;
	padding: 3px 0 3px 0;
}

ul > li::before {
	position: absolute;
	top: 0;
	left: -14px;
	width: 10px;
	height: 14px;
	border-bottom: 1px solid var(--vp-c-divider);
	border-left: 1px solid var(--vp-c-divider);
	content: '';
}

ul > li:not(:last-child)::after {
	position: absolute;
	top: 14px;
	bottom: 0;
	left: -14px;
	border-left: 1px solid var(--vp-c-divider);
	content: '';
}

.ref {
	margin-right: 8px;
}

.dim {
	color: var(--vp-c-text-2);
}

.also {
	margin-left: 8px;
	font-size: 13px;
}
</style>
