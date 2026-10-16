<script setup lang="ts">
import type {
  PublicationOpenOverviewPanelEmits,
  PublicationOpenOverviewPanelProps,
  SinglePublicationStateType,
} from './typing'
import type {
  DocumentSinglePublicationEffectiveState,
  DocumentSinglePublicationScope,
  DocumentSinglePublicationState,
  DocumentSinglePublicationTreeItem,
} from '@/apis/document-publication'
import { Search } from '@element-plus/icons-vue'
import {
  DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE,
  DOCUMENT_SINGLE_PUBLICATION_SCOPE,
  DOCUMENT_SINGLE_PUBLICATION_SCOPE_VALUES,
  DOCUMENT_SINGLE_PUBLICATION_STATE,
} from '@haohaoxue/lexora-contracts/document/publication/constants'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import { LoadingTableSkeleton } from '@/components/loading'

const props = withDefaults(defineProps<PublicationOpenOverviewPanelProps>(), {
  loading: false,
  updatingDocumentId: null,
})
const emits = defineEmits<PublicationOpenOverviewPanelEmits>()
const { t } = useI18n()

const searchText = shallowRef('')
const stateFilter = shallowRef<'all' | DocumentSinglePublicationEffectiveState>('all')
const selectedDocumentId = shallowRef('')

const singlePublicationStateOptions = computed(() => [
  {
    value: DOCUMENT_SINGLE_PUBLICATION_STATE.INHERIT,
    label: t('docs.publicationSite.overview.inheritParent'),
  },
  {
    value: DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED,
    label: t('docs.publicationSite.overview.publicLink'),
  },
  {
    value: DOCUMENT_SINGLE_PUBLICATION_STATE.DISABLED,
    label: t('docs.publication.closeCurrent'),
  },
])
const singlePublicationScopeOptions = computed(() => DOCUMENT_SINGLE_PUBLICATION_SCOPE_VALUES.map(value => ({
  value,
  label: formatSinglePublicationScope(value),
})))
const stateFilterOptions = computed(() => [
  {
    value: 'all',
    label: t('docs.publicationSite.overview.allStates'),
  },
  {
    value: DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.ENABLED,
    label: t('docs.publicationSite.overview.public'),
  },
  {
    value: DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.INHERITED_ENABLED,
    label: t('docs.publicationSite.overview.inheritedEnabled'),
  },
  {
    value: DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.DISABLED,
    label: t('docs.publicationSite.overview.closed'),
  },
  {
    value: DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.UNPUBLISHED,
    label: t('docs.publicationSite.overview.notPublished'),
  },
] satisfies Array<{ value: 'all' | DocumentSinglePublicationEffectiveState, label: string }>)

const flatTree = computed(() => props.tree.flatMap(item => flattenDocumentTree(item)))
const selectedRow = computed(() =>
  flatTree.value.find(item => item.id === selectedDocumentId.value) ?? flatTree.value[0] ?? null,
)
const filteredTree = computed(() =>
  filterDocumentTree(props.tree, searchText.value.trim().toLowerCase(), stateFilter.value),
)
const documentTitleById = computed(() =>
  new Map(flatTree.value.map(item => [item.id, item.title || t('docs.common.noTitle')])),
)

watch(
  flatTree,
  (items) => {
    if (selectedDocumentId.value && items.some(item => item.id === selectedDocumentId.value)) {
      return
    }

    selectedDocumentId.value = items[0]?.id ?? ''
  },
  { immediate: true },
)

function resolveSingleStateType(state: DocumentSinglePublicationEffectiveState): SinglePublicationStateType {
  if (state === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.ENABLED) {
    return 'success'
  }

  if (state === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.INHERITED_ENABLED) {
    return 'primary'
  }

  if (state === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.DISABLED) {
    return 'warning'
  }

  return 'info'
}

function resolveSingleStateLabel(state: DocumentSinglePublicationEffectiveState) {
  if (state === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.ENABLED) {
    return t('docs.publicationSite.overview.public')
  }

  if (state === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.INHERITED_ENABLED) {
    return t('docs.publicationSite.overview.inheritedEnabled')
  }

  if (state === DOCUMENT_SINGLE_PUBLICATION_EFFECTIVE_STATE.DISABLED) {
    return t('docs.publicationSite.overview.closed')
  }

  return t('docs.publicationSite.overview.notPublished')
}

function resolveSingleRuleLabel(state: DocumentSinglePublicationState) {
  return singlePublicationStateOptions.value.find(option => option.value === state)?.label ?? t('docs.publicationSite.overview.inheritParent')
}

function resolveSingleScopeLabel(row: DocumentSinglePublicationTreeItem) {
  if (row.singlePublicationState !== DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED) {
    return t('docs.publicationSite.overview.inheritParent')
  }

  return formatSinglePublicationScope(row.singlePublicationScope)
}

function resolveSingleRuleDescription(row: DocumentSinglePublicationTreeItem) {
  if (row.singlePublicationState === DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED) {
    return t('docs.publicationSite.overview.directRuleDescription')
  }

  if (row.singlePublicationState === DOCUMENT_SINGLE_PUBLICATION_STATE.DISABLED) {
    return t('docs.publicationSite.overview.unpublishedByRule')
  }

  if (row.inheritedFromDocumentId) {
    return t('docs.publicationSite.overview.inheritedFrom', {
      title: documentTitleById.value.get(row.inheritedFromDocumentId) ?? t('docs.publicationSite.overview.parentPage'),
    })
  }

  return t('docs.publicationSite.overview.noCustomRule')
}

function resolveSingleScopeDescription(row: DocumentSinglePublicationTreeItem) {
  if (row.singlePublicationState !== DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED) {
    return t('docs.publicationSite.overview.currentRangeInactive')
  }

  return row.singlePublicationScope === DOCUMENT_SINGLE_PUBLICATION_SCOPE.DESCENDANTS
    ? t('docs.publicationSite.overview.effectiveForChildren')
    : t('docs.publicationSite.overview.effectiveForCurrent')
}

function formatSinglePublicationScope(scope: DocumentSinglePublicationScope) {
  return scope === DOCUMENT_SINGLE_PUBLICATION_SCOPE.DESCENDANTS
    ? t('docs.publication.scopeTree')
    : t('docs.publication.scopePage')
}

function handleSingleStateCommand(row: DocumentSinglePublicationTreeItem, command: string | number | object) {
  emits(
    'updateState',
    row.id,
    String(command) as DocumentSinglePublicationState,
    row.singlePublicationScope,
  )
}

function handleSingleScopeCommand(row: DocumentSinglePublicationTreeItem, command: string | number | object) {
  emits(
    'updateState',
    row.id,
    DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED,
    String(command) as DocumentSinglePublicationScope,
  )
}

function handleRowClick(row: DocumentSinglePublicationTreeItem) {
  selectedDocumentId.value = row.id
}

function resolveRowClassName({ row }: { row: DocumentSinglePublicationTreeItem }) {
  return row.id === selectedDocumentId.value ? 'is-selected' : ''
}

function flattenDocumentTree(item: DocumentSinglePublicationTreeItem): DocumentSinglePublicationTreeItem[] {
  return [
    item,
    ...item.children.flatMap(child => flattenDocumentTree(child)),
  ]
}

function filterDocumentTree(
  items: DocumentSinglePublicationTreeItem[],
  keyword: string,
  state: 'all' | DocumentSinglePublicationEffectiveState,
): DocumentSinglePublicationTreeItem[] {
  return items.flatMap((item) => {
    const children = filterDocumentTree(item.children, keyword, state)
    const matchesKeyword = !keyword || (item.title || t('docs.common.noTitle')).toLowerCase().includes(keyword)
    const matchesState = state === 'all' || item.effectivePublicationState === state

    if ((matchesKeyword && matchesState) || children.length > 0) {
      return [{
        ...item,
        children,
      }]
    }

    return []
  })
}
</script>

<template>
  <section class="publication-open-overview-panel grid gap-5">
    <header class="publication-open-overview-panel__header flex flex-wrap items-end justify-between gap-3">
      <div class="grid gap-1">
        <h2 class="m-0 text-xl font-semibold leading-7 text-main">
          {{ t('docs.publicationSite.overview.title') }}
        </h2>
      </div>

      <div class="flex flex-wrap items-center justify-end gap-2">
        <ElInput
          v-model="searchText"
          class="publication-open-overview-panel__search"
          clearable
          :placeholder="t('docs.publicationSite.overview.searchPlaceholder')"
        >
          <template #suffix>
            <ElIcon class="text-secondary">
              <Search />
            </ElIcon>
          </template>
        </ElInput>
        <ElSelect v-model="stateFilter" class="publication-open-overview-panel__filter">
          <ElOption
            v-for="option in stateFilterOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </ElSelect>
      </div>
    </header>

    <div class="grid grid-cols-[minmax(0,1fr)_minmax(21rem,24rem)] items-start gap-5 max-[1180px]:grid-cols-1">
      <div class="publication-open-overview-panel__surface overflow-hidden rounded-xl border bg-surface">
        <ElTable
          :data="filteredTree"
          row-key="id"
          class="publication-open-overview-panel__table"
          :tree-props="{ children: 'children' }"
          :row-class-name="resolveRowClassName"
          default-expand-all
          @row-click="handleRowClick"
        >
          <template #empty>
            <LoadingTableSkeleton v-if="loading" compact />
            <Empty v-else compact :description="t('docs.publicationSite.overview.empty')" />
          </template>

          <ElTableColumn :label="t('docs.publicationSite.overview.document')" min-width="205" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="inline-flex min-w-0 items-center gap-2">
                <SvgIcon
                  category="ui"
                  :icon="row.hasChildren ? 'document-tree-folder' : 'document-tree-file'"
                  size="1rem"
                />
                <span class="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ row.title }}</span>
              </span>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('docs.publicationSite.overview.publicState')" width="104" align="center" header-align="center">
            <template #default="{ row }">
              <ElTag
                size="small"
                :type="resolveSingleStateType(row.effectivePublicationState)"
                effect="light"
              >
                {{ resolveSingleStateLabel(row.effectivePublicationState) }}
              </ElTag>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('docs.publicationSite.overview.publicRule')" width="120" align="center" header-align="center">
            <template #default="{ row }">
              <ElDropdown
                trigger="click"
                @command="command => handleSingleStateCommand(row, command)"
              >
                <ElButton
                  text
                  size="small"
                  class="publication-open-overview-panel__dropdown-trigger gap-1 rounded-lg px-2"
                  :loading="updatingDocumentId === row.id"
                >
                  {{ resolveSingleRuleLabel(row.singlePublicationState) }}
                  <SvgIcon category="ui" icon="chevron-down" size="0.78rem" />
                </ElButton>

                <template #dropdown>
                  <ElDropdownMenu>
                    <ElDropdownItem
                      v-for="option in singlePublicationStateOptions"
                      :key="option.value"
                      :command="option.value"
                      :disabled="row.singlePublicationState === option.value"
                    >
                      {{ option.label }}
                    </ElDropdownItem>
                  </ElDropdownMenu>
                </template>
              </ElDropdown>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('docs.publicationSite.overview.scope')" width="136" align="center" header-align="center">
            <template #default="{ row }">
              <ElDropdown
                trigger="click"
                :disabled="row.singlePublicationState !== DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED || updatingDocumentId === row.id"
                @command="command => handleSingleScopeCommand(row, command)"
              >
                <ElButton
                  text
                  size="small"
                  class="publication-open-overview-panel__dropdown-trigger min-w-[5.5rem] justify-between gap-1 rounded-lg px-2"
                  :disabled="row.singlePublicationState !== DOCUMENT_SINGLE_PUBLICATION_STATE.ENABLED || updatingDocumentId === row.id"
                >
                  {{ resolveSingleScopeLabel(row) }}
                  <SvgIcon category="ui" icon="chevron-down" size="0.78rem" />
                </ElButton>

                <template #dropdown>
                  <ElDropdownMenu>
                    <ElDropdownItem
                      v-for="option in singlePublicationScopeOptions"
                      :key="option.value"
                      :command="option.value"
                      :disabled="row.singlePublicationScope === option.value"
                    >
                      {{ option.label }}
                    </ElDropdownItem>
                  </ElDropdownMenu>
                </template>
              </ElDropdown>
            </template>
          </ElTableColumn>
        </ElTable>
      </div>

      <aside v-if="selectedRow" class="publication-open-overview-panel__inspector grid gap-4 rounded-xl border bg-surface p-4">
        <div class="grid gap-3">
          <div class="flex items-start gap-3">
            <SvgIcon
              category="ui"
              :icon="selectedRow.hasChildren ? 'document-tree-folder' : 'document-tree-file'"
              size="1.1rem"
              class="mt-1 shrink-0"
            />
            <div class="grid min-w-0 gap-2">
              <h2 class="m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-lg font-semibold leading-7 text-main">
                {{ selectedRow.title || t('docs.common.noTitle') }}
              </h2>
            </div>
          </div>
        </div>

        <div class="publication-open-overview-panel__detail-list grid gap-0">
          <div class="publication-open-overview-panel__detail-row">
            <span>{{ t('docs.publicationSite.overview.publicState') }}</span>
            <div class="publication-open-overview-panel__detail-value">
              <ElTag
                size="small"
                :type="resolveSingleStateType(selectedRow.effectivePublicationState)"
                effect="light"
              >
                {{ resolveSingleStateLabel(selectedRow.effectivePublicationState) }}
              </ElTag>
            </div>
          </div>
          <div class="publication-open-overview-panel__detail-row">
            <span>{{ t('docs.publicationSite.overview.publicRule') }}</span>
            <div class="publication-open-overview-panel__detail-value">
              <strong>{{ resolveSingleRuleLabel(selectedRow.singlePublicationState) }}</strong>
              <small>{{ resolveSingleRuleDescription(selectedRow) }}</small>
            </div>
          </div>
          <div class="publication-open-overview-panel__detail-row">
            <span>{{ t('docs.publicationSite.overview.scope') }}</span>
            <div class="publication-open-overview-panel__detail-value">
              <strong>{{ resolveSingleScopeLabel(selectedRow) }}</strong>
              <small>{{ resolveSingleScopeDescription(selectedRow) }}</small>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped lang="scss">
.publication-open-overview-panel__search {
  width: 16.25rem;
}

.publication-open-overview-panel__filter {
  width: 10rem;
}

.publication-open-overview-panel__header {
  min-height: 2.25rem;
}

.publication-open-overview-panel__surface,
.publication-open-overview-panel__inspector {
  border-color: color-mix(in srgb, var(--brand-border-base) 74%, transparent);
  box-shadow: var(--brand-shadow-hairline);
}

.publication-open-overview-panel__table {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-fill-color-blank: transparent;
  --el-table-border-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  --el-table-header-bg-color: color-mix(in srgb, var(--brand-fill-lighter) 42%, transparent);
  --el-table-header-text-color: var(--brand-text-secondary);
  --el-table-text-color: var(--brand-text-secondary);
  --el-table-row-hover-bg-color: color-mix(in srgb, var(--brand-primary) 4%, white);

  :deep(.el-table__inner-wrapper::before) {
    display: none;
  }

  :deep(th.el-table__cell) {
    height: 3.2rem;
    padding: 0 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  :deep(td.el-table__cell) {
    height: 3.85rem;
    padding: 0 0.875rem;
  }

  :deep(.el-table__row) {
    cursor: pointer;
  }

  :deep(.el-table__row.is-selected > td.el-table__cell) {
    background: color-mix(in srgb, var(--brand-primary) 7%, white);
  }

  :deep(.el-table__row .el-table__cell:first-child .cell) {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  :deep(.el-table__indent) {
    flex: 0 0 auto;
  }

  :deep(.el-table__expand-icon),
  :deep(.el-table__placeholder) {
    display: inline-flex;
    flex: 0 0 1rem;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    margin-right: 0.375rem;
    color: var(--brand-text-secondary);
    vertical-align: middle;
  }

  :deep(.el-table__expand-icon .el-icon) {
    font-size: 0.75rem;
  }
}

.publication-open-overview-panel__dropdown-trigger {
  color: var(--brand-text-secondary);
  font-weight: 400;
  min-height: 2rem;

  &:hover {
    background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  }
}

.publication-open-overview-panel__more {
  color: var(--brand-text-secondary);
}

.publication-open-overview-panel__icon-button {
  color: var(--brand-text-secondary);
  border-color: color-mix(in srgb, var(--brand-border-base) 74%, transparent);
}

.publication-open-overview-panel__detail-list {
  border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 64%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 64%, transparent);
}

.publication-open-overview-panel__detail-row {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  gap: 0.75rem;
  align-items: start;
  min-height: 3.75rem;
  padding: 0.875rem 0;
  color: var(--brand-text-secondary);
  font-size: 0.8125rem;

  & + & {
    border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 58%, transparent);
  }
}

.publication-open-overview-panel__detail-value {
  display: grid;
  justify-items: end;
  gap: 0.375rem;
  min-width: 0;
  text-align: right;

  strong {
    min-width: 0;
    overflow: hidden;
    color: var(--brand-text-primary);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    color: var(--brand-text-secondary);
    font-size: 0.75rem;
    line-height: 1.35;
  }
}
</style>
