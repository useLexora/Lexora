<script setup lang="ts">
import type { ExtensionCatalogEntry, ExtensionCatalogSnapshot } from '@buddy-shared/extensions/extensionCatalog'
import { NAlert, NButton, NEllipsis, NEmpty, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import { gt } from 'semver'
import { computed, onScopeDispose, shallowRef } from 'vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { useExtensionContext } from '../extensionContext'

defineProps<{ busy: boolean }>()
const emit = defineEmits<{ install: [entry: ExtensionCatalogEntry] }>()
const { state, language } = useExtensionContext()
const snapshot = shallowRef<ExtensionCatalogSnapshot | null>(null)
const loading = shallowRef(false)
const query = shallowRef('')
const category = shallowRef<string | null>(null)
const error = shallowRef(false)
const en = computed(() => language.value === 'en-US')
let disposed = false
let revision = 0
const categories = computed(() => [...new Set(snapshot.value?.plugins.flatMap(item => item.manifest.categories) ?? [])].map(value => ({ label: value, value })))
const plugins = computed(() => (snapshot.value?.plugins ?? []).filter((item) => {
  const { manifest } = item
  const text = [manifest.id, manifest.author, manifest.name, manifest.description, ...manifest.tags].join(' ').toLocaleLowerCase()
  return (!category.value || manifest.categories.includes(category.value)) && text.includes(query.value.trim().toLocaleLowerCase())
}).map((item) => {
  const installed = state.installed.value.find(next => next.manifest.id === item.manifest.id)
  const version = installed?.pending?.manifest.version ?? installed?.manifest.version
  return { ...item, installed, available: item.compatible && (!version || gt(item.manifest.version, version)) }
}))
async function refresh(force = false) {
  const current = ++revision
  loading.value = true
  error.value = false
  try {
    const next = await state.api.catalog(force)
    if (!disposed && revision === current) {
      snapshot.value = next
      error.value = !!next.error
    }
  }
  catch {
    if (!disposed && revision === current)
      error.value = true
  }
  finally {
    if (!disposed && revision === current)
      loading.value = false
  }
}
void refresh()
onScopeDispose(() => {
  disposed = true
  revision++
})
</script>

<template>
  <section class="extension-catalog" data-testid="extension-catalog">
    <div class="extension-catalog__search">
      <NInput v-model:value="query" clearable :placeholder="en ? 'Search plugins' : '搜索插件名称、描述或标签'" :aria-label="en ? 'Search plugins' : '搜索插件'" />
      <NSelect v-if="categories.length" v-model:value="category" clearable :options="categories" :placeholder="en ? 'Category' : '分类'" :aria-label="en ? 'Category' : '分类'" />
      <NButton :loading="loading" @click="refresh(true)">
        {{ en ? 'Refresh' : '刷新' }}
      </NButton>
    </div>
    <NAlert v-if="error" type="warning" :title="en ? 'Could not refresh marketplace' : '暂时无法刷新插件市场'">
      {{ snapshot?.plugins.length ? (en ? 'Showing the last saved catalog.' : '正在显示上次缓存的插件目录。') : (en ? 'Try again later, or install a local package.' : '请稍后重试，也可以先安装本地插件包。') }}
    </NAlert>
    <NSpin :show="loading && !snapshot">
      <NEmpty v-if="!plugins.length" class="extension-catalog__empty" :description="en ? 'No plugins to display' : '暂无可展示的插件'" />
      <div v-else class="extension-catalog__grid">
        <article v-for="item in plugins" :key="item.manifest.id" :data-catalog-id="item.manifest.id" class="extension-catalog__card">
          <header><DesktopPluginIcon :src="item.iconUrl" :size="28" /><h2>{{ item.manifest.name }}</h2><span>{{ item.manifest.version }}</span></header>
          <NEllipsis class="extension-catalog__author">
            {{ item.manifest.author || (en ? 'Unsigned' : '未署名') }}
          </NEllipsis>
          <p>{{ item.manifest.description }}</p>
          <div class="extension-catalog__tags">
            <NTag v-for="tag in item.manifest.tags" :key="tag" size="small" :bordered="false">
              {{ tag }}
            </NTag>
          </div>
          <footer>
            <NButton size="small" :type="item.available ? 'primary' : 'default'" :disabled="busy || !item.available" @click="emit('install', item)">
              {{ !item.compatible ? (en ? 'Incompatible' : '版本不兼容') : !item.available ? (en ? 'Installed' : '已安装') : item.installed ? (en ? 'Update' : '更新') : (en ? 'Install' : '安装') }}
            </NButton>
          </footer>
        </article>
      </div>
    </NSpin>
  </section>
</template>

<style scoped>
.extension-catalog { display: grid; gap: 18px; }
.extension-catalog__search { display: flex; gap: 10px; align-items: center; }
.extension-catalog__search :deep(.n-select) { width: 130px; flex: none; }
.extension-catalog__empty { padding: 100px 0; }
.extension-catalog__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 12px; }
.extension-catalog__card { display: flex; flex-direction: column; min-width: 0; gap: 10px; padding: 18px; border: 1px solid var(--buddy-border-subtle); border-radius: var(--buddy-radius-micro); }
.extension-catalog__card header { display: flex; gap: 10px; justify-content: space-between; align-items: center; }
.extension-catalog__card h2 { flex: 1; min-width: 0; font-size: 14px; color: var(--buddy-text-strong); font-weight: 600; margin: 0; overflow-wrap: anywhere; }
.extension-catalog__author, .extension-catalog__card header span { color: var(--buddy-text-secondary); font-size: 11px; }
.extension-catalog__card p { margin: 0; font-size: 13px; color: var(--buddy-text-secondary); line-height: 1.7; }
.extension-catalog__tags { display: flex; flex-wrap: wrap; gap: 6px; }
.extension-catalog__card footer { margin-top: auto; padding-top: 8px; }
</style>
