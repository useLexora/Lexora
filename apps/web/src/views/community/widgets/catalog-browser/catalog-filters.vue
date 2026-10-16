<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ query: string, category: string, categories: string[] }>()
const emit = defineEmits<{ filter: [query: string, category: string] }>()
const { t } = useI18n()
const input = shallowRef(props.query)
watch(() => props.query, value => input.value = value)
</script>

<template>
  <div class="catalog-toolbar">
    <div class="catalog-title">
      <h1>{{ t('explore') }}</h1>
      <p>{{ t('subtitle') }}</p>
    </div>
    <form class="search" role="search" @submit.prevent="emit('filter', input.trim(), category)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
      <input v-model="input" :placeholder="t('search')" :aria-label="t('search')" maxlength="100" type="search">
      <button type="submit" :aria-label="t('explore')">
        ↵
      </button>
    </form>
  </div>
  <nav class="categories" :aria-label="t('categories')">
    <button :aria-pressed="!category" @click="emit('filter', query, '')">
      {{ t('allPlugins') }}
    </button>
    <button v-for="item in categories" :key="item" :aria-pressed="category === item" @click="emit('filter', query, item)">
      {{ item }}
    </button>
  </nav>
</template>

<style scoped lang="scss">
.catalog-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 32px; margin-bottom: 30px; }
.catalog-title h1 { font-size: 30px; }
.catalog-title p { color: var(--muted); margin-top: 8px; font-size: 14px; }
.search { display: flex; align-items: center; gap: 12px; width: min(420px, 100%); padding: 13px 16px; border: 1px solid var(--line); background: var(--surface); border-radius: 12px; }
.search:focus-within { border-color: var(--accent); }
.search svg { width: 20px; height: 20px; color: var(--muted); flex-shrink: 0; }
.search input { min-width: 0; flex: 1; background: none; border: none; color: var(--ink); outline-offset: 5px; font-size: 14px; }
.search input::placeholder { color: var(--muted); }
.search button { border: none; color: var(--muted); background: var(--canvas); border-radius: 6px; width: 28px; height: 28px; font-size: 18px; }
.categories { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.categories button { padding: 7px 18px; border: 1px solid transparent; border-radius: 8px; color: var(--muted); background: transparent; }
.categories button:hover { background: var(--accent-soft); color: var(--ink); }
.categories button[aria-pressed='true'] { background: var(--ink); color: var(--canvas); }
@media (max-width: 740px) { .catalog-toolbar { flex-direction: column; align-items: stretch; gap: 22px; margin-bottom: 22px; }.search { width: 100%; }.catalog-title h1 { font-size: 26px; }.categories { gap: 5px; }.categories button { padding-inline: 14px; } }
</style>
