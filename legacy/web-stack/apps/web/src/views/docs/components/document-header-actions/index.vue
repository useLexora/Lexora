<script setup lang="ts">
import type { DocumentPageWidthMode } from '@haohaoxue/lexora-contracts/document'
import type { PageWidthOptionView } from './typing'
import {
  DOCUMENT_PAGE_WIDTH_MODE,
  DOCUMENT_PAGE_WIDTH_MODE_VALUES,
} from '@haohaoxue/lexora-contracts/document/constants'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChatAssistantAvatar } from '@/components/chat-message'
import { useDocumentHeaderActions } from '../../composables/useDocumentHeaderActions'

const pageWidthPreviewClass: Record<DocumentPageWidthMode, string> = {
  [DOCUMENT_PAGE_WIDTH_MODE.NARROW]: 'is-narrow',
  [DOCUMENT_PAGE_WIDTH_MODE.DEFAULT]: 'is-default',
  [DOCUMENT_PAGE_WIDTH_MODE.FULL]: 'is-full',
}
const { t } = useI18n()
const pageWidthLabelKey: Record<DocumentPageWidthMode, string> = {
  [DOCUMENT_PAGE_WIDTH_MODE.NARROW]: 'docs.pageWidth.narrow',
  [DOCUMENT_PAGE_WIDTH_MODE.DEFAULT]: 'docs.pageWidth.default',
  [DOCUMENT_PAGE_WIDTH_MODE.FULL]: 'docs.pageWidth.full',
}

const pageWidthOptions = computed<PageWidthOptionView[]>(() => DOCUMENT_PAGE_WIDTH_MODE_VALUES.map(value => ({
  value,
  label: t(pageWidthLabelKey[value]),
  previewClass: pageWidthPreviewClass[value],
})))

const {
  currentPageWidthMode,
  canShowPublicationButton,
  handleMenuCommand,
  handlePageWidthOptionClick,
  isDocsChatPanelOpen,
  openPublicationDialog,
  toggleDocsChatPanel,
} = useDocumentHeaderActions()
</script>

<template>
  <div class="document-header-actions flex items-center gap-1.5 text-main">
    <ElTooltip
      :content="t('docs.common.aiChat')"
      effect="dark"
      placement="bottom"
      :show-after="120"
    >
      <ElButton
        text
        class="document-header-actions__icon-button h-7 min-w-7 w-7 rounded-lg p-0 text-base"
        :class="{ 'is-active': isDocsChatPanelOpen }"
        :title="t('docs.common.aiChat')"
        @click="toggleDocsChatPanel"
      >
        <ChatAssistantAvatar />
      </ElButton>
    </ElTooltip>

    <ElButton
      v-if="canShowPublicationButton"
      text
      class="document-header-actions__share-button h-7 min-h-7 rounded-lg border px-2 font-normal"
      :title="t('docs.common.share')"
      @click="openPublicationDialog"
    >
      <span class="inline-flex items-center gap-1 text-xs">
        <SvgIcon category="ui" icon="share-public" />
        <span class="text-xs leading-none">{{ t('docs.common.share') }}</span>
      </span>
    </ElButton>

    <ElDropdown
      trigger="click"
      popper-class="document-header-actions__more-popper"
      @command="handleMenuCommand"
    >
      <ElButton
        text
        class="document-header-actions__icon-button h-7 min-w-7 w-7 rounded-lg p-0 text-base"
        :title="t('docs.common.more')"
      >
        <SvgIcon category="ui" icon="more" />
      </ElButton>

      <template #dropdown>
        <ElDropdownMenu class="document-header-actions__menu box-border min-w-0 max-w-36 w-36 p-1">
          <ElPopover
            trigger="hover"
            placement="left-start"
            :width="296"
            :show-arrow="false"
            :show-after="80"
            :hide-after="80"
            :popper-style="{ padding: '0' }"
          >
            <template #reference>
              <li
                class="document-header-actions__menu-item el-dropdown-menu__item box-border flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-main"
                role="menuitem"
                tabindex="0"
              >
                <span class="inline-flex h-4 w-4 flex-none items-center justify-center text-[color-mix(in_srgb,var(--brand-text-secondary)_86%,transparent)]">
                  <SvgIcon category="ui" icon="page-width" size="1rem" />
                </span>
                <span class="min-w-0 flex-1 overflow-hidden text-sm leading-5 text-ellipsis whitespace-nowrap">
                  {{ t('docs.pageWidth.title') }}
                </span>
                <span class="inline-flex h-[0.875rem] w-[0.875rem] flex-none items-center justify-center text-sm text-[color-mix(in_srgb,var(--brand-text-secondary)_72%,transparent)]">
                  <SvgIcon category="ui" icon="chevron-right" />
                </span>
              </li>
            </template>

            <section class="document-page-width-menu px-2 pb-2 pt-2">
              <div class="mb-2 text-xs leading-5 text-secondary">
                {{ t('docs.pageWidth.description') }}
              </div>

              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="option in pageWidthOptions"
                  :key="option.value"
                  type="button"
                  class="document-page-width-menu__option flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg border bg-surface p-1.5 text-main"
                  :class="[
                    option.previewClass,
                    { 'is-active': currentPageWidthMode === option.value },
                  ]"
                  @click="handlePageWidthOptionClick(option.value)"
                >
                  <span class="document-page-width-menu__preview flex h-[2.875rem] w-[3.625rem] items-center justify-center rounded-md" aria-hidden="true">
                    <span class="document-page-width-menu__preview-surface flex w-8 flex-col gap-px rounded px-1 py-1">
                      <span class="document-page-width-menu__preview-line h-[0.15625rem] rounded-full is-primary" />
                      <span class="document-page-width-menu__preview-line h-[0.15625rem] rounded-full" />
                      <span class="document-page-width-menu__preview-line h-[0.15625rem] w-[72%] rounded-full is-short" />
                    </span>
                  </span>
                  <span class="text-[13px] font-medium leading-5">
                    {{ option.label }}
                  </span>
                </button>
              </div>
            </section>
          </ElPopover>

          <ElDropdownItem
            command="document-info"
            divided
            class="document-header-actions__menu-item my-1 min-h-8 w-full box-border gap-2 rounded-lg px-2 text-main"
          >
            <template #icon>
              <span class="inline-flex h-4 w-4 flex-none items-center justify-center text-[16px] text-[color-mix(in_srgb,var(--brand-text-secondary)_86%,transparent)]">
                <SvgIcon category="ui" icon="info" size="1rem" />
              </span>
            </template>
            {{ t('docs.common.documentInfo') }}
          </ElDropdownItem>

          <ElDropdownItem
            command="history"
            class="document-header-actions__menu-item min-h-8 w-full box-border gap-2 rounded-lg px-2 text-main"
          >
            <template #icon>
              <span class="inline-flex h-4 w-4 flex-none items-center justify-center text-[16px] text-[color-mix(in_srgb,var(--brand-text-secondary)_86%,transparent)]">
                <SvgIcon category="ui" icon="history" size="1rem" />
              </span>
            </template>
            {{ t('docs.common.history') }}
          </ElDropdownItem>
        </ElDropdownMenu>
      </template>
    </ElDropdown>
  </div>
</template>

<style scoped lang="scss">
.document-header-actions {
  .document-header-actions__share-button {
    --el-button-text-color: color-mix(in srgb, var(--brand-text-primary) 78%, var(--brand-text-secondary));
    --el-button-hover-text-color: var(--brand-text-primary);
    --el-button-active-text-color: var(--brand-text-primary);
    --el-button-border-color: color-mix(in srgb, var(--brand-border-base) 84%, transparent);
    --el-button-hover-border-color: color-mix(in srgb, var(--brand-text-primary) 18%, transparent);
    --el-button-active-border-color: color-mix(in srgb, var(--brand-text-primary) 22%, transparent);
    --el-button-bg-color: var(--brand-bg-surface);
    --el-button-hover-bg-color: color-mix(in srgb, var(--brand-fill-lighter) 72%, white);
    --el-button-active-bg-color: color-mix(in srgb, var(--brand-fill-lighter) 86%, white);
    border: 1px solid var(--el-button-border-color);
    background: var(--el-button-bg-color);

    &:disabled {
      opacity: 0.48;
    }
  }

  .document-header-actions__icon-button {
    --el-button-text-color: var(--brand-text-primary);
    --el-button-hover-text-color: var(--brand-text-primary);
    --el-button-active-text-color: var(--brand-text-primary);
    --el-button-hover-bg-color: color-mix(in srgb, var(--brand-fill-lighter) 70%, white);
    --el-button-active-bg-color: color-mix(in srgb, var(--brand-fill-lighter) 84%, white);
    color: var(--brand-text-primary);

    &.is-copied {
      color: var(--brand-success);
    }

    &.is-active {
      background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
      color: var(--brand-primary);
    }
  }
}

.document-page-width-menu {
  .document-page-width-menu__option {
    border: 1px solid color-mix(in srgb, var(--brand-border-base) 80%, transparent);
    transition:
      border-color 0.18s ease,
      background-color 0.18s ease,
      color 0.18s ease;

    &:hover,
    &:focus-visible {
      border-color: color-mix(in srgb, var(--brand-primary) 24%, transparent);
      background: color-mix(in srgb, var(--brand-primary) 4%, white);
      outline: none;
    }

    &.is-active {
      border-color: color-mix(in srgb, var(--brand-primary) 54%, transparent);
      background: color-mix(in srgb, var(--brand-primary) 8%, white);
      color: var(--brand-primary);
    }
  }

  .document-page-width-menu__preview {
    background: color-mix(in srgb, var(--brand-fill-lighter) 82%, white);
  }

  .document-page-width-menu__preview-surface {
    background: color-mix(in srgb, var(--brand-bg-surface) 86%, white);
  }

  .document-page-width-menu__option.is-narrow .document-page-width-menu__preview-surface {
    width: 1.5rem;
  }

  .document-page-width-menu__option.is-full .document-page-width-menu__preview-surface {
    width: 2.875rem;
  }

  .document-page-width-menu__preview-line {
    background: color-mix(in srgb, var(--brand-text-secondary) 32%, transparent);

    &.is-primary {
      background: color-mix(in srgb, var(--brand-primary) 42%, white);
    }
  }
}

:global(.document-header-actions__more-popper) {
  --el-dropdown-menuItem-hover-color: var(--brand-text-primary);
  --el-dropdown-menuItem-hover-fill: color-mix(in srgb, var(--brand-fill-lighter) 76%, var(--brand-text-primary) 6%);
}

:global(.document-header-actions__more-popper .el-dropdown-menu__item--divided) {
  border-top-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
}

:global(.document-header-actions__more-popper .el-dropdown-menu__item:not(.is-disabled):focus:not(:focus-visible):not(:hover)) {
  background-color: transparent;
  color: var(--brand-text-primary);
}
</style>
