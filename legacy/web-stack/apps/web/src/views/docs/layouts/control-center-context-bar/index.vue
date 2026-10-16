<script setup lang="ts">
import type { DocsControlCenterContextBarModel } from './typing'
import { useI18n } from 'vue-i18n'

const activeTab = defineModel<DocsControlCenterContextBarModel>({ required: true })
const { t } = useI18n()
</script>

<template>
  <ElTabs v-model="activeTab" class="docs-control-center-context-bar flex h-full max-w-full w-fit items-center">
    <ElTabPane name="publications">
      <template #label>
        <span class="inline-flex h-[var(--default-header-height)] items-center px-3.5 text-[15px] font-medium leading-none">
          {{ t('docs.common.publication') }}
        </span>
      </template>
    </ElTabPane>
    <ElTabPane name="trash">
      <template #label>
        <span class="inline-flex h-[var(--default-header-height)] items-center px-3.5 text-[15px] font-medium leading-none">
          {{ t('docs.common.trash') }}
        </span>
      </template>
    </ElTabPane>
  </ElTabs>
</template>

<style scoped lang="scss">
.docs-control-center-context-bar {
  :deep(.el-tabs__header) {
    height: 100%;
    margin: 0;
  }

  :deep(.el-tabs__nav-wrap) {
    height: 100%;
  }

  :deep(.el-tabs__nav-scroll),
  :deep(.el-tabs__nav) {
    height: 100%;
  }

  :deep(.el-tabs__nav-wrap::after) {
    display: none;
  }

  :deep(.el-tabs__active-bar) {
    height: 0.1875rem;
    border-radius: 50%;
    background: var(--brand-primary);
  }

  :deep(.el-tabs__item) {
    height: 100%;
    color: var(--brand-text-secondary);
    padding: 0;
    transition: color 0.18s ease;
  }

  :deep(.el-tabs__item.is-active),
  :deep(.el-tabs__item:not(.is-disabled):hover) {
    color: var(--brand-text-primary);
  }

  :deep(.el-tabs__content) {
    display: none;
  }
}
</style>
