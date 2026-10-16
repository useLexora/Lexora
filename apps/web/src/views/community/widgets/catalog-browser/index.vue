<script setup lang="ts">
import type { PluginPage } from '@uselexora/lexora-contracts/community'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useResource } from '@/composables/use-resource'
import { api } from '@/utils/axios'
import CatalogFilters from './catalog-filters.vue'
import PluginCard from './plugin-card.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const query = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const category = computed(() => typeof route.query.category === 'string' ? route.query.category : '')
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const categories = shallowRef<string[]>([])
const { data, loading, error, reload } = useResource(() => JSON.stringify([query.value, category.value, page.value]), async (_key, signal) => {
  const [plugins, available] = await Promise.all([
    api.get<PluginPage>('/plugins', { params: { q: query.value, category: category.value, page: page.value }, signal }),
    api.get<string[]>('/categories', { signal }),
  ])
  if (!signal.aborted)
    categories.value = available.data
  return plugins.data
})
function filter(q: string, selected: string) {
  void router.replace({ query: { ...(q ? { q } : {}), ...(selected ? { category: selected } : {}) } })
}
function paginate(value: number) {
  void router.replace({ query: { ...route.query, page: value } })
}
</script>

<template>
  <section class="catalog-section" :aria-label="t('explore')">
    <CatalogFilters :query="query" :category="category" :categories="categories" @filter="filter" />
    <div class="catalog-status" aria-live="polite">
      <span>{{ loading ? t('loading') : data ? t('results', { count: data.total }) : '' }}</span>
      <span v-if="query" class="search-term">“{{ query }}”</span>
    </div>
    <div v-if="error" role="alert" class="notice">
      {{ error }} <button class="text-button" @click="reload">
        {{ t('retry') }}
      </button>
    </div>
    <div v-else-if="loading" class="plugin-grid" role="status" :aria-label="t('loading')">
      <div v-for="item in 6" :key="item" class="skeleton" />
    </div>
    <template v-else-if="data">
      <div v-if="!data.items.length" class="empty-state">
        <h2>{{ t('empty') }}</h2><p class="mt-2">
          {{ t('emptyHint') }}
        </p>
      </div>
      <div v-else class="plugin-grid">
        <PluginCard v-for="plugin in data.items" :key="plugin.id" :plugin="plugin" />
      </div>
      <nav v-if="data.total > data.pageSize" class="pagination" :aria-label="t('pagination')">
        <button class="button button-secondary" :disabled="page <= 1" @click="paginate(page - 1)">
          {{ t('previous') }}
        </button>
        <span>{{ page }} / {{ Math.ceil(data.total / data.pageSize) }}</span>
        <button class="button button-secondary" :disabled="page * data.pageSize >= data.total" @click="paginate(page + 1)">
          {{ t('next') }}
        </button>
      </nav>
    </template>
  </section>
</template>

<style scoped lang="scss">
.catalog-status { display: flex; gap: 12px; min-height: 54px; align-items: center; color: var(--muted); font-size: 13px; }
.search-term { color: var(--ink); overflow-wrap: anywhere; }
.plugin-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.pagination { display: flex; justify-content: center; align-items: center; gap: 24px; margin-top: 32px; }
@media (max-width: 950px) { .plugin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .plugin-grid { grid-template-columns: 1fr; gap: 14px; } }
</style>
