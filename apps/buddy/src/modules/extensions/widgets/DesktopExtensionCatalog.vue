<script setup lang="ts">
import type { ExtensionCatalogListing, ExtensionCatalogSnapshot } from '@buddy-shared/extensions/extensionCatalog'
import { NAlert, NButton, NEmpty, NInput, NSelect, NSpin } from 'naive-ui'
import { gt } from 'semver'
import { computed, shallowRef } from 'vue'
import { useExtensionContext } from '../extensionContext'
import { extensionLabels } from '../extensionLabels'
import DesktopExtensionCatalogCard from './DesktopExtensionCatalogCard.vue'
import DesktopExtensionCompatibilityHint from './DesktopExtensionCompatibilityHint.vue'

const props = defineProps<{ snapshot: ExtensionCatalogSnapshot | null, loading: boolean, error: boolean }>()
const emit = defineEmits<{ install: [entry: ExtensionCatalogListing], applyUpdate: [id: string], refresh: [] }>()
const { state, language } = useExtensionContext()
const query = shallowRef('')
const category = shallowRef<string | null>(null)
const en = computed(() => language.value === 'en-US')
const labels = computed(() => extensionLabels(language.value))
const categories = computed(() => [...new Set(props.snapshot?.plugins.flatMap(item => item.manifest.categories) ?? [])].map(value => ({ label: value, value })))
const plugins = computed(() => (props.snapshot?.plugins ?? []).filter((item) => {
  const { manifest } = item
  const text = [manifest.id, manifest.author, manifest.name, manifest.description, ...manifest.tags].join(' ').toLocaleLowerCase()
  return (!category.value || manifest.categories.includes(category.value)) && text.includes(query.value.trim().toLocaleLowerCase())
}).map((item) => {
  const installed = state.installed.value.find(next => next.manifest.id === item.manifest.id)
  const retained = state.unavailable.value.find(next => next.manifest.id === item.manifest.id && !next.pending)
  const version = installed?.pending?.manifest.version ?? installed?.manifest.version ?? retained?.manifest.version
  return { ...item, installed, installedVersion: version, available: !version || gt(item.manifest.version, version) }
}))
</script>

<template>
  <section class="extension-catalog grid gap-[18px]" data-testid="extension-catalog">
    <div class="extension-catalog__search flex gap-[10px] items-center">
      <NInput v-model:value="query" clearable :placeholder="en ? 'Search plugins' : '搜索插件名称、描述或标签'" :aria-label="en ? 'Search plugins' : '搜索插件'" />
      <NSelect v-if="categories.length" v-model:value="category" clearable :options="categories" :placeholder="en ? 'Category' : '分类'" :aria-label="en ? 'Category' : '分类'" />
      <NButton :loading="loading" @click="emit('refresh')">
        {{ en ? 'Refresh' : '刷新' }}
      </NButton>
    </div>
    <NAlert v-if="error" type="warning" :title="en ? 'Could not refresh marketplace' : '暂时无法刷新插件市场'">
      {{ snapshot?.plugins.length ? (en ? 'Showing the last saved catalog.' : '正在显示上次缓存的插件目录。') : (en ? 'Try again later, or install a local package.' : '请稍后重试，也可以先安装本地插件包。') }}
    </NAlert>
    <NAlert v-if="snapshot?.invalidEntries" type="warning">
      {{ en ? 'Some plugin information could not be read. Other plugins remain available.' : '部分插件信息无法读取，其他插件仍可正常使用。' }}
    </NAlert>
    <NSpin :show="loading && !snapshot">
      <NEmpty v-if="!plugins.length" class="extension-catalog__empty" :description="en ? 'No plugins to display' : '暂无可展示的插件'" />
      <div v-else class="grid grid-cols-[repeat(auto-fill,_minmax(min(100%,_280px),_1fr))] gap-[12px]">
        <DesktopExtensionCatalogCard v-for="item in plugins" :key="item.manifest.id" :data-catalog-id="item.manifest.id" class="extension-catalog__card" :manifest="item.manifest" :icon-url="item.iconUrl" :repository="item.repository" :language="language">
          <template #actions>
            <NButton v-if="item.installed?.pending?.manifest.version === item.manifest.version && !item.available" size="small" type="primary" :loading="state.busyIds.has(item.manifest.id)" :disabled="!item.compatible || !!item.installed.pending.incompatibility" data-testid="catalog-apply-update" @click="emit('applyUpdate', item.manifest.id)">
              {{ labels.applyUpdate }}
            </NButton>
            <NButton v-else size="small" :type="item.available ? 'primary' : 'default'" :loading="state.busyIds.has(item.manifest.id)" :disabled="!item.compatible || !item.available" @click="emit('install', item)">
              {{ state.busyIds.has(item.manifest.id) ? (en ? 'Verifying plugin…' : '正在核验插件…') : !item.available ? (en ? 'Installed' : '已安装') : item.installedVersion ? (en ? 'Update' : '更新') : (en ? 'Install' : '安装') }}
            </NButton>
            <DesktopExtensionCompatibilityHint v-if="item.incompatibility" :issue="item.incompatibility" :language="language" />
          </template>
        </DesktopExtensionCatalogCard>
      </div>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
.extension-catalog__search :deep(.n-select) {
  width: 130px;
  flex: none;
}

.extension-catalog__empty {
  padding: 100px 0;
}
</style>
