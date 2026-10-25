<script setup lang="ts">
import type { FileOpeningChoice, FileOpeningReviewChoice } from '@buddy-shared/files/fileOpening'
import { NCheckbox, NTable } from 'naive-ui'
import { computed } from 'vue'

const props = defineProps<{ associations: FileOpeningReviewChoice[], language: string, busy: boolean }>()
const selected = defineModel<FileOpeningChoice[]>({ required: true })
const english = computed(() => props.language === 'en-US')
const locations = ['inline', 'standalone'] as const
const key = (choice: FileOpeningChoice) => `${choice.extension}:${choice.location}`
const selectedProviders = computed(() => new Map(selected.value.map(choice => [key(choice), choice.providerId])))
const rows = computed(() => {
  const grouped = new Map<string, Record<FileOpeningChoice['location'], FileOpeningReviewChoice[]>>()
  for (const choice of props.associations) {
    const row = grouped.get(choice.extension) ?? { inline: [], standalone: [] }
    row[choice.location].push(choice)
    grouped.set(choice.extension, row)
  }
  return [...grouped].map(([extension, choices]) => ({ extension, choices }))
})
const columns = computed(() => locations.map((location) => {
  const cells = rows.value.map(row => row.choices[location])
  const choices = cells.every(cell => cell.length <= 1)
    ? cells.flat()
    : []
  const count = choices.filter(choice => selectedProviders.value.get(key(choice)) === choice.providerId).length
  return {
    location,
    label: location === 'inline' ? (english.value ? 'File preview' : '文件内预览') : (english.value ? 'Open separately' : '独立打开'),
    choices,
    checked: choices.length > 0 && count === choices.length,
    indeterminate: count > 0 && count < choices.length,
  }
}))

function isChecked(choice: FileOpeningReviewChoice) {
  return selectedProviders.value.get(key(choice)) === choice.providerId
}

function select(choices: FileOpeningReviewChoice[], checked: boolean) {
  const changed = new Set(choices.map(key))
  selected.value = [
    ...selected.value.filter(choice => !changed.has(key(choice))),
    ...(checked ? choices.map(({ extension, location, providerId }) => ({ extension, location, providerId })) : []),
  ]
}
</script>

<template>
  <section class="grid gap-2.5" data-testid="extension-file-associations">
    <div>
      <h3 class="m-0 text-[13px] font-semibold text-fg leading-[1.5]">
        {{ english ? 'Default openers' : '默认打开方式' }}
      </h3>
      <p class="mt-1 mb-0 text-[12px] text-muted leading-[1.6]">
        {{ english ? 'Use this plugin for checked items in Lexora. Unchecked items keep their current defaults.' : '勾选后在 Lexora 中默认使用此插件；未选项目保留原设置。' }}
      </p>
    </div>
    <NTable
      class="extension-associations-table table-fixed !overflow-visible text-[12px]"
      size="small"
      :single-line="true"
      :theme-overrides="{ thFontWeight: '500', thPaddingSmall: '6px 12px', tdPaddingSmall: '6px 12px' }"
    >
      <colgroup>
        <col class="w-[19%]">
        <col>
        <col>
      </colgroup>
      <thead class="sticky top-0 z-1">
        <tr>
          <th scope="col">
            {{ english ? 'Extension' : '文件后缀' }}
          </th>
          <th v-for="column in columns" :key="column.location" scope="col">
            <NCheckbox
              v-if="column.choices.length > 1"
              :checked="column.checked" :indeterminate="column.indeterminate"
              :disabled="busy" :aria-disabled="busy"
              @update:checked="select(column.choices, $event)"
            >
              <span class="sr-only">{{ english ? 'Select all: ' : '全选：' }}</span>{{ column.label }}
            </NCheckbox>
            <template v-else>
              {{ column.label }}
            </template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.extension">
          <th scope="row" class="align-middle font-mono [overflow-wrap:anywhere]">
            {{ row.extension }}
          </th>
          <td v-for="column in columns" :key="column.location" class="align-top">
            <template v-if="row.choices[column.location].length">
              <div class="grid gap-2">
                <NCheckbox
                  v-for="choice in row.choices[column.location]" :key="choice.providerId"
                  :checked="isChecked(choice)" :disabled="busy" :aria-disabled="busy"
                  @update:checked="select([choice], $event)"
                >
                  <span class="sr-only">{{ row.extension }} · {{ column.label }} · </span><span :class="{ 'sr-only': row.choices[column.location].length === 1 }">{{ choice.title }}</span>
                </NCheckbox>
              </div>
            </template>
            <span v-else class="text-muted">{{ english ? 'Not provided' : '不提供' }}</span>
          </td>
        </tr>
      </tbody>
    </NTable>
  </section>
</template>

<style scoped lang="scss">
.extension-associations-table {
  :deep(.n-checkbox) {
    align-items: flex-start;
    font-size: 12px;
  }

  :deep(.n-checkbox__label) {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  tbody th {
    background: var(--n-td-color);
    color: var(--n-td-text-color);
    font-weight: 500;
  }
}
</style>
