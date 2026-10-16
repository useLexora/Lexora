<script setup lang="ts">
import type { Plugin } from '@uselexora/lexora-contracts/community'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps<{ plugin: Plugin }>()
const tone = computed(() => Array.from(props.plugin.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3)
</script>

<template>
  <RouterLink :to="`/plugins/${encodeURIComponent(plugin.id)}`" class="plugin-card" :class="`tone-${tone}`">
    <div class="card-heading">
      <div class="plugin-icon" aria-hidden="true">
        {{ plugin.release.manifest.name.slice(0, 1) }}
      </div>
      <span class="category">{{ plugin.release.manifest.categories[0] }}</span>
    </div>
    <h2>{{ plugin.release.manifest.name }}</h2>
    <p class="description">
      {{ plugin.release.manifest.description }}
    </p>
    <div class="card-footer">
      <span class="publisher">{{ plugin.publisher.displayName }} <small>@{{ plugin.publisher.handle }}</small></span>
      <span class="version">v{{ plugin.release.manifest.version }}</span>
    </div>
  </RouterLink>
</template>

<style scoped lang="scss">
.plugin-card { display: flex; flex-direction: column; min-width: 0; padding: 24px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); transition: border-color .15s, box-shadow .15s; }
.plugin-card:hover { border-color: var(--accent); box-shadow: 0 4px 18px #12364d0a; }
.plugin-card h2 { overflow-wrap: anywhere; margin-top: 19px; font-size: 18px; font-weight: 600; }
.card-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.plugin-icon { width: 48px; height: 48px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); border-radius: 13px; font-size: 22px; font-weight: 600; }
.tone-1 .plugin-icon { background: var(--art-warm); color: var(--ink); }
.tone-2 .plugin-icon { background: var(--art-blue); }
.category { color: var(--muted); font-size: 12px; }
.description { color: var(--muted); margin-top: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 46px; font-size: 13px; }
.card-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; padding-top: 26px; font-size: 12px; color: var(--muted); }
.publisher { overflow-wrap: anywhere; }.publisher small { margin-left: 5px; font-size: 11px; }.version { flex-shrink: 0; }
</style>
