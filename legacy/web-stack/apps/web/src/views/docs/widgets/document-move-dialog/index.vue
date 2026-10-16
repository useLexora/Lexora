<script setup lang="ts">
import type {
  DocumentItem,
  DocumentTreeCollectionId,
  DocumentTreeGroup,
  OwnedDocumentCollectionId,
} from '@haohaoxue/lexora-contracts/document'
import type { MoveTreeNode, SelectedMoveTarget } from './typing'

import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getDocuments } from '@/apis/document'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocsPageActions } from '../../composables/useDocsPageActions'
import { useDocumentTree } from '../../composables/useDocumentTree'
import { findDocumentItemPath, resolveDocumentTreeItemIcon } from '../../utils/documentTree'

const workspaceStore = useWorkspaceStore()
const tree = useDocumentTree()
const pageActions = useDocsPageActions()
const { t } = useI18n()

const selectedWorkspaceId = shallowRef<string>('')
const selectedTarget = shallowRef<SelectedMoveTarget | null>(null)
const targetGroups = shallowRef<DocumentTreeGroup[]>([])
const isLoading = shallowRef(false)
const isMoving = shallowRef(false)
let loadRequestId = 0

const target = computed(() => tree.moveDialogTarget.value)
const isOpen = computed(() => tree.isMoveDialogOpen.value)
const visibleGroups = computed(() => targetGroups.value)
const canConfirm = computed(() => Boolean(target.value && selectedTarget.value) && !isMoving.value)
const selectedTargetLabel = computed(() => selectedTarget.value?.label ?? t('docs.moveDialog.selectTarget'))

watch(isOpen, async (open) => {
  if (!open) {
    selectedTarget.value = null
    targetGroups.value = []
    return
  }

  const workspace = await workspaceStore.ensurePersonalWorkspace()
  if (!isOpen.value) {
    return
  }

  selectedWorkspaceId.value = workspace.id
  selectedTarget.value = null
  await loadTargetTree(workspace.id)

  if (isOpen.value) {
    selectRootTarget()
  }
})

async function loadTargetTree(workspaceId: string) {
  const requestId = ++loadRequestId

  if (!workspaceId) {
    targetGroups.value = []
    return
  }

  isLoading.value = true

  try {
    const groups = await getDocuments(workspaceId)

    if (requestId !== loadRequestId) {
      return
    }

    targetGroups.value = groups
  }
  finally {
    if (requestId === loadRequestId) {
      isLoading.value = false
    }
  }
}

function selectRootTarget() {
  const group = visibleGroups.value.find(item => isOwnedCollection(item.id))
  const collectionId = group?.id

  if (!collectionId || !isOwnedCollection(collectionId) || !selectedWorkspaceId.value) {
    selectedTarget.value = null
    return
  }

  selectedTarget.value = {
    workspaceId: selectedWorkspaceId.value,
    collectionId,
    parentId: null,
    label: t('docs.moveDialog.root'),
  }
}

function selectDocumentNode(group: DocumentTreeGroup, node: MoveTreeNode) {
  if (!isOwnedCollection(group.id) || node.disabled || !selectedWorkspaceId.value) {
    return
  }

  selectedTarget.value = {
    workspaceId: selectedWorkspaceId.value,
    collectionId: group.id,
    parentId: node.id,
    label: getDocumentNodePathLabel(group, node),
  }
}

function toTreeNodes(items: DocumentItem[]): MoveTreeNode[] {
  const excludedIds = target.value?.movingDocumentIds ?? new Set<string>()

  return items.map(item => ({
    id: item.id,
    title: item.title,
    hasChildren: item.hasChildren,
    hasContent: item.hasContent,
    disabled: excludedIds.has(item.id),
    children: toTreeNodes(item.children),
  }))
}

function getMoveTreeNodeIcon(node: MoveTreeNode, expanded: boolean) {
  return resolveDocumentTreeItemIcon(node, expanded)
}

function getDocumentNodePathLabel(group: DocumentTreeGroup, node: MoveTreeNode) {
  const path = findDocumentItemPath(group.nodes, node.id)

  return path?.map(item => item.title).join('/') ?? node.title
}

async function confirmMove() {
  if (!target.value || !selectedTarget.value || isMoving.value) {
    return
  }

  isMoving.value = true

  try {
    await pageActions.moveDocumentTree(target.value.documentId, {
      targetWorkspaceId: selectedTarget.value.workspaceId,
      targetParentId: selectedTarget.value.parentId,
      targetCollectionId: selectedTarget.value.collectionId,
    })
    tree.closeMoveDialog()
  }
  finally {
    isMoving.value = false
  }
}

function closeDialog() {
  if (isMoving.value) {
    return
  }

  tree.closeMoveDialog()
}

function isOwnedCollection(collectionId: DocumentTreeCollectionId): collectionId is OwnedDocumentCollectionId {
  return Boolean(collectionId)
}
</script>

<template>
  <ElDialog
    :model-value="isOpen"
    :title="t('docs.moveDialog.title')"
    width="760px"
    destroy-on-close
    align-center
    class="document-move-dialog"
    body-class="document-move-dialog__content pt-2"
    @update:model-value="closeDialog"
  >
    <div class="document-move-dialog__body rounded-lg">
      <section
        class="document-move-dialog__tree min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface p-2"
        :aria-label="t('docs.moveDialog.targetDocumentTree')"
      >
        <ElSkeleton v-if="isLoading" animated class="p-2">
          <template #template>
            <div class="grid gap-2">
              <div v-for="node in 7" :key="node" class="flex items-center gap-2" :class="node > 1 ? 'pl-5' : ''">
                <ElSkeletonItem variant="circle" class="h-4 w-4 shrink-0" />
                <ElSkeletonItem variant="text" class="max-w-56" />
              </div>
            </div>
          </template>
        </ElSkeleton>

        <template v-else>
          <div
            v-for="group in visibleGroups"
            :key="group.id"
            class="min-w-0"
          >
            <ElTree
              v-if="group.nodes.length"
              :data="toTreeNodes(group.nodes)"
              node-key="id"
              :props="{ label: 'title', children: 'children', disabled: 'disabled' }"
              highlight-current
              :current-node-key="selectedTarget?.parentId ?? undefined"
              default-expand-all
              class="document-move-dialog__el-tree"
              @node-click="(node: MoveTreeNode) => selectDocumentNode(group, node)"
            >
              <template #default="{ node, data }">
                <span class="inline-flex min-w-0 items-center gap-2">
                  <SvgIcon category="ui" :icon="getMoveTreeNodeIcon(data, Boolean(node.expanded))" size="1rem" />
                  <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ data.title }}</span>
                </span>
              </template>
            </ElTree>
          </div>
        </template>
      </section>
    </div>

    <div class="document-move-dialog__target mt-3 flex min-h-8 items-center gap-2 text-[13px] leading-6 text-secondary">
      <span class="shrink-0">{{ t('docs.moveDialog.targetLocation') }}</span>
      <span
        class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-main"
        :title="selectedTargetLabel"
      >
        {{ selectedTargetLabel }}
      </span>
    </div>

    <template #footer>
      <ElButton :disabled="isMoving" @click="closeDialog">
        {{ t('docs.common.cancel') }}
      </ElButton>
      <ElButton
        class="ml-[10px]!"
        type="primary"
        :loading="isMoving"
        :disabled="!canConfirm"
        @click="confirmMove"
      >
        {{ t('docs.common.confirm') }}
      </ElButton>
    </template>
  </ElDialog>
</template>

<style scoped lang="scss">
.document-move-dialog__body {
  display: flex;
  height: min(26rem, calc(100vh - 15rem));
  min-height: 18rem;
  border: 1px solid var(--brand-border-base);
  overflow: hidden;
}

.document-move-dialog__el-tree {
  --el-tree-node-hover-bg-color: var(--brand-fill-lighter);
}

:global(.document-move-dialog .document-move-dialog__content) {
  display: flex;
  min-height: 0;
  flex-direction: column;
}
</style>
