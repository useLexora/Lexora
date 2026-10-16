<script setup lang="ts">
import type { SettingsContextBarModel } from './typing'
import { useI18n } from 'vue-i18n'

const activeTab = defineModel<SettingsContextBarModel>({ required: true })
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <ElTabs v-model="activeTab" class="settings-context-bar flex h-full max-w-full w-fit items-center">
    <ElTabPane name="user">
      <template #label>
        <span class="inline-flex h-[var(--default-header-height)] items-center pr-3.5 text-[15px] font-medium leading-none">
          {{ t('settings.tabs.account') }}
        </span>
      </template>
    </ElTabPane>
    <ElTabPane name="preference">
      <template #label>
        <span class="inline-flex h-[var(--default-header-height)] items-center px-3.5 text-[15px] font-medium leading-none">
          {{ t('settings.tabs.preference') }}
        </span>
      </template>
    </ElTabPane>
    <ElTabPane name="providers">
      <template #label>
        <span class="inline-flex h-[var(--default-header-height)] items-center px-3.5 text-[15px] font-medium leading-none">
          {{ t('settings.tabs.providers') }}
        </span>
      </template>
    </ElTabPane>
  </ElTabs>
</template>

<style scoped lang="scss">
.settings-context-bar {
  :deep(.el-tabs__header) {
    margin: 0;
    height: 100%;
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

  :deep(.el-tabs__item.is-active) {
    color: var(--brand-text-primary);
  }

  :deep(.el-tabs__item:not(.is-disabled):hover) {
    color: var(--brand-text-primary);
  }

  :deep(.el-tabs__content) {
    display: none;
  }
}
</style>
