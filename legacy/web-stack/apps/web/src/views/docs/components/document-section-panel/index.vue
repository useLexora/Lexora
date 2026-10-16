<script setup lang="ts">
import type { DocumentItem as DocumentTreeItemModel } from '@haohaoxue/lexora-contracts'
import type { CheckedInfo, TreeNode, TreeNodeData, TreeV2Instance } from 'element-plus'
import type {
  DocumentSectionPanelEmits,
  DocumentSectionPanelProps,
  DocumentSectionPanelSlots,
} from './typing'
import { useElementSize } from '@vueuse/core'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocsContext } from '../../composables/useDocsContext'
import { useDocumentSectionPanel } from '../../composables/useDocumentSectionPanel'
import { countDocumentItems, findDocumentItemPath, isOwnedDocumentCollection } from '../../utils/documentTree'
import DocumentItem from '../document-item'
import DocumentToolbar from '../document-toolbar'

const props = defineProps<DocumentSectionPanelProps>()
const emit = defineEmits<DocumentSectionPanelEmits>()
defineSlots<DocumentSectionPanelSlots>()
const { t } = useI18n()
const DOCUMENT_TREE_ITEM_SIZE = 36
const DOCUMENT_TREE_MAX_HEIGHT = 420

const { chevronIconName, displayLabel, isCollapsed, toggleSection } = useDocumentSectionPanel({
  group: () => props.group,
})
const { activeDocumentId } = useDocsContext()
const treeRef = shallowRef<TreeV2Instance>()
const treeBodyRef = useTemplateRef<HTMLElement>('treeBody')
const { height: treeBodyHeight } = useElementSize(treeBodyRef)
const isOwnedCollection = computed(() => isOwnedDocumentCollection(props.group.id))
const canCreateRoot = computed(() => isOwnedCollection.value && !props.selectionMode)
const emptyDescription = computed(() => t('docs.treeMenu.emptyDocuments'))
const treeProps = {
  value: 'id',
  label: 'title',
  children: 'children',
}
const treeHeight = computed(() =>
  props.fillHeight
    ? Math.max(Math.floor(treeBodyHeight.value), DOCUMENT_TREE_ITEM_SIZE)
    : Math.min(
        Math.max(countDocumentItems(props.group.nodes) * DOCUMENT_TREE_ITEM_SIZE, DOCUMENT_TREE_ITEM_SIZE),
        DOCUMENT_TREE_MAX_HEIGHT,
      ),
)
const canSelectDocuments = computed(() => Boolean(props.selectionMode && isOwnedCollection.value))
const activeDocumentAncestorIds = computed(() => {
  if (!activeDocumentId.value) {
    return []
  }

  const path = findDocumentItemPath(props.group.nodes, activeDocumentId.value)

  return path?.slice(0, -1).map(document => document.id) ?? []
})

watch(
  [activeDocumentAncestorIds, () => props.group.nodes],
  () => {
    nextTick(() => {
      expandActiveDocumentAncestors()
    })
  },
  { flush: 'post', immediate: true },
)

watch(
  () => props.selectionMode,
  () => {
    emit('checkedChange', [])
    nextTick(() => {
      treeRef.value?.setCheckedKeys([])
    })
  },
)

function handleCheck(_data: TreeNodeData, info: CheckedInfo) {
  emit('checkedChange', info.checkedKeys.map(key => String(key)))
}

function handleNodeClick(data: TreeNodeData) {
  const document = data as DocumentTreeItemModel

  if (props.selectionMode) {
    return
  }

  emit('open', document.id)
}

function getNodeClass(data: TreeNodeData, node: TreeNode) {
  return {
    'is-document-current': activeDocumentId.value === data.id,
    'is-document-checked': isNodeChecked(node),
  }
}

function isNodeChecked(node: TreeNode) {
  return Boolean((node as TreeNode & { isEffectivelyChecked?: boolean }).isEffectivelyChecked)
}

function expandActiveDocumentAncestors() {
  const treeInstance = treeRef.value

  if (!treeInstance) {
    return
  }

  for (const documentId of activeDocumentAncestorIds.value) {
    const node = treeInstance.getNode(documentId)

    if (node && !node.expanded) {
      treeInstance.expandNode(node)
    }
  }
}
</script>

<template>
  <section
    class="document-tree-section flex min-w-0 flex-col"
    :class="{ 'document-tree-section--fill min-h-0 flex-1': props.fillHeight }"
  >
    <div class="document-tree-section__header group flex h-8 items-center gap-1 px-3">
      <button
        type="button"
        class="document-tree-section__header-button flex h-full w-full min-w-0 flex-1 cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-secondary transition-[background-color,color] duration-200 focus-visible:outline-none"
        :aria-expanded="!isCollapsed"
        :aria-controls="`document-tree-section-group-${props.group.id}`"
        @click="toggleSection"
      >
        <SvgIcon
          category="ui"
          :icon="chevronIconName"
          size="0.875rem"
          class="document-tree-section__chevron shrink-0 text-[0.875rem] transition-transform duration-200"
        />
        <span class="min-w-0 truncate text-sm leading-none">{{ displayLabel }}</span>
      </button>

      <div
        v-if="$slots.headerAction || canCreateRoot"
        class="document-tree-section__actions flex shrink-0 items-center gap-1"
      >
        <div v-if="$slots.headerAction" class="inline-flex items-center" @click.stop>
          <slot name="headerAction" :group="props.group" />
        </div>

        <div
          v-if="canCreateRoot"
          class="shrink-0 cursor-default"
          @click.stop
        >
          <DocumentToolbar :collection-id="props.group.id" />
        </div>
      </div>
    </div>

    <div
      v-if="!isCollapsed && props.group.nodes.length"
      :id="`document-tree-section-group-${props.group.id}`"
      ref="treeBody"
      role="group"
      class="document-tree-section__body min-w-0 px-3 pb-1 pt-1"
      :class="{ 'min-h-0 flex-1': props.fillHeight }"
    >
      <ElTreeV2
        :key="props.group.id"
        ref="treeRef"
        class="document-tree-section__tree"
        :data="props.group.nodes"
        :props="{ ...treeProps, class: getNodeClass }"
        :height="treeHeight"
        :item-size="DOCUMENT_TREE_ITEM_SIZE"
        :indent="18"
        :scrollbar-always-on="true"
        :show-checkbox="canSelectDocuments"
        :check-on-click-node="canSelectDocuments"
        :check-on-click-leaf="canSelectDocuments"
        :expand-on-click-node="!canSelectDocuments"
        :highlight-current="true"
        :current-node-key="activeDocumentId ?? undefined"
        @check="handleCheck"
        @node-click="handleNodeClick"
      >
        <template #default="{ node, data }">
          <DocumentItem
            :item="data"
            :collection-id="props.group.id"
            :selection-mode="props.selectionMode"
            :checked="isNodeChecked(node)"
            :expanded="Boolean(node.expanded)"
          />
        </template>
      </ElTreeV2>
    </div>

    <div
      v-else-if="!isCollapsed"
      class="document-tree-section__empty flex min-h-9 items-center px-9 py-1.5 text-[13px] leading-5 text-secondary"
    >
      {{ emptyDescription }}
    </div>
  </section>
</template>

<style scoped lang="scss">
.document-tree-section {
  & + & {
    margin-top: 0.375rem;
    padding-top: 0.375rem;
    border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 62%, transparent);
  }

  &__header {
    background: color-mix(in srgb, var(--brand-fill-light) 74%, var(--brand-bg-sidebar));
    transition: background-color 0.2s ease;

    &:hover,
    &:focus-within {
      background: color-mix(in srgb, var(--brand-fill-light) 54%, var(--brand-bg-surface));
    }
  }

  &__header-button {
    color: var(--brand-text-secondary);
  }

  &__chevron {
    color: var(--brand-text-secondary);
  }

  &__tree {
    --el-tree-node-content-height: 36px;
    background: transparent;

    :deep(.el-tree-node__content) {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid transparent;
      border-radius: 0.5rem;
      padding-right: 0.625rem;
      transition:
        border-color 0.2s ease,
        background-color 0.2s ease,
        box-shadow 0.2s ease;
    }

    :deep(.el-tree-node__content > .el-tree-node__content) {
      flex: 1 1 0%;
      min-width: 0;
    }

    :deep(.el-tree-node__label) {
      display: flex;
      flex: 1 1 0%;
      min-width: 0;
    }

    :deep(.el-tree-node__expand-icon) {
      color: var(--brand-text-secondary);
    }

    :deep(.el-tree-node__content:hover) {
      border-color: color-mix(in srgb, var(--brand-border-base) 70%, transparent);
      background: var(--brand-fill-lighter);
    }

    :deep(.el-tree-node.is-document-current > .el-tree-node__content) {
      border-color: color-mix(in srgb, var(--brand-primary) 20%, transparent);
      background: color-mix(in srgb, var(--brand-primary) 10%, transparent);
      box-shadow:
        0 1px 2px 0 color-mix(in srgb, var(--brand-primary) 6%, transparent),
        0 1px 2px 0 color-mix(in srgb, var(--brand-text-primary) 5%, transparent);
    }

    :deep(.el-tree-node.is-document-checked > .el-tree-node__content) {
      border-color: color-mix(in srgb, var(--brand-primary) 18%, transparent);
      background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
    }
  }
}
</style>
