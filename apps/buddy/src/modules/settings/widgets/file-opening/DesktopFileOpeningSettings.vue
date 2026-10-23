<script setup lang="ts">
import { Search20Regular } from '@vicons/fluent'
import { NAlert, NButton, NInput, NSpin, NTable } from 'naive-ui'
import { computed, shallowRef, useId } from 'vue'
import { useFileOpening } from '@/modules/files'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopFileOpeningSelect from './DesktopFileOpeningSelect.vue'

const props = defineProps<{ language: string }>()
const state = useFileOpening()
if (!state)
  throw new Error('File opening state is unavailable')
const { snapshot, loading, loaded, error, refresh, setDefault } = state
const english = computed(() => props.language === 'en-US')
const searchId = useId()
const search = shallowRef('')
const searchLabel = computed(() => english.value ? 'Search file extensions' : '搜索文件后缀')
const extensions = computed(() => {
  const query = search.value.trim().toLowerCase()
  const providers = snapshot.value.providers
  return [...new Set(providers.flatMap(provider => provider.extensions))].sort().filter(extension => extension.includes(query))
})
const locations = ['inline', 'standalone'] as const

function retry() {
  void refresh().catch(() => {})
}
</script>

<template>
  <section class="desktop-file-opening-settings grid gap-4 [container-type:inline-size]">
    <label :for="searchId" class="sr-only">{{ searchLabel }}</label>
    <NInput v-model:value="search" class="max-w-[24rem]" clearable :input-props="{ id: searchId }" :placeholder="searchLabel">
      <template #prefix>
        <DesktopIcon :component="Search20Regular" aria-hidden="true" />
      </template>
    </NInput>
    <NAlert v-if="error" type="error" :show-icon="false">
      <div class="flex items-center justify-between gap-3">
        <span>{{ english ? 'Could not load file opening preferences.' : '无法读取打开方式设置。' }} {{ error }}</span>
        <NButton size="small" :loading="loading" @click="retry">
          {{ english ? 'Retry' : '重试' }}
        </NButton>
      </div>
    </NAlert>
    <div v-if="!loaded && loading" class="flex items-center gap-2 text-muted" role="status">
      <NSpin size="small" />
      {{ english ? 'Loading file opening preferences…' : '正在读取打开方式…' }}
    </div>
    <NTable v-if="extensions.length" size="small" class="desktop-file-opening-table table-fixed !overflow-visible" :theme-overrides="{ thFontWeight: '500', tdPaddingSmall: '10px 12px', thPaddingSmall: '12px' }">
      <colgroup>
        <col class="w-[18%]">
        <col>
        <col>
      </colgroup>
      <thead class="sticky top-0 z-1 text-[12px]">
        <tr>
          <th scope="col">
            {{ english ? 'Extension' : '文件后缀' }}
          </th>
          <th scope="col">
            {{ english ? 'File preview' : '文件内预览' }}
          </th>
          <th scope="col">
            {{ english ? 'Open separately' : '独立打开' }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="extension in extensions" :key="extension">
          <th scope="row" class="align-middle text-[13px] font-mono [overflow-wrap:anywhere]">
            {{ extension }}
          </th>
          <td v-for="location in locations" :key="location" class="align-top">
            <DesktopFileOpeningSelect
              :extension="extension" :location="location" :snapshot="snapshot"
              :language="language" :disabled="!loaded" :save="setDefault"
            />
          </td>
        </tr>
      </tbody>
    </NTable>
    <p v-else-if="loaded" class="m-0 py-8 text-center text-[13px] text-muted" role="status">
      {{ english ? 'No matching file types.' : '没有匹配的文件类型。' }}
    </p>
  </section>
</template>

<style scoped lang="scss">
.desktop-file-opening-table {
  thead th:first-child {
    border-top-left-radius: var(--n-border-radius);
  }

  thead th:last-child {
    border-top-right-radius: var(--n-border-radius);
  }

  tbody th {
    background: var(--n-td-color);
    color: var(--n-td-text-color);
    white-space: normal;
  }

  tbody tr:last-child th {
    border-bottom: 0;
    border-bottom-left-radius: var(--n-border-radius);
  }

  tbody tr:last-child td:last-child {
    border-bottom-right-radius: var(--n-border-radius);
  }

  @container (max-width: 540px) {
    colgroup,
    thead {
      display: none;
    }

    tbody {
      display: block;
    }

    tr {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      padding: 0.75rem;
      gap: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--n-border-color);
    }

    tr:last-child {
      border-bottom: 0;
    }

    th {
      grid-column: 1 / -1;
    }

    th,
    td {
      padding: 0;
      border-bottom: 0;
    }
  }

  @container (max-width: 360px) {
    tr {
      grid-template-columns: minmax(0, 1fr);
    }
  }
}
</style>
