<script setup lang="ts">
import type { DocumentToolbarProps } from './typing'
import { useI18n } from 'vue-i18n'
import { useDocsPageActions } from '../../composables/useDocsPageActions'
import { useDocumentTree } from '../../composables/useDocumentTree'

const props = defineProps<DocumentToolbarProps>()
const { t } = useI18n()

const { isMutatingTree: isBusy } = useDocumentTree()
const { createRootDocument } = useDocsPageActions()

function handleCreateRoot() {
  void createRootDocument(props.collectionId)
}
</script>

<template>
  <ElButton
    text
    class="document-tree-toolbar document-tree-toolbar__button h-7 min-w-7 w-7 rounded-lg p-0"
    :disabled="isBusy"
    :title="t('docs.common.createDocument')"
    @click="handleCreateRoot"
  >
    <SvgIcon category="ui" :icon="isBusy ? 'spinner-orbit' : 'plus'" size="1rem" :class="{ 'animate-spin': isBusy }" />
  </ElButton>
</template>

<style scoped lang="scss">
.document-tree-toolbar {
  &.document-tree-toolbar__button {
    --el-button-text-color: var(--brand-text-secondary);
    --el-button-hover-text-color: var(--brand-primary);
    --el-button-hover-bg-color: var(--brand-bg-surface-raised);
    --el-button-border-color: transparent;
    --el-button-hover-border-color: transparent;
    color: var(--brand-text-secondary);

    &:hover {
      color: var(--brand-primary);
      background: var(--brand-bg-surface-raised);
    }

    &:disabled {
      opacity: 0.4;
    }
  }
}
</style>
