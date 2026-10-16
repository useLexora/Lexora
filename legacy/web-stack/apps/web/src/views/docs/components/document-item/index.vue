<script setup lang="ts">
import type { DocumentItemProps } from './typing'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentItem } from '../../composables/useDocumentItem'
import { resolveDocumentTreeItemIcon } from '../../utils/documentTree'

const props = defineProps<DocumentItemProps>()
const { t } = useI18n()
const {
  actionsStateClass,
  canManageDocument,
  createChild,
  handleMenuCommand,
  isActionPending,
  itemStateClass,
  menuItems,
} = useDocumentItem({
  collectionId: () => props.collectionId,
  item: () => props.item,
})

const treeIconName = computed(() => {
  return resolveDocumentTreeItemIcon(props.item, Boolean(props.expanded))
})
</script>

<template>
  <div class="document-tree-item w-full min-w-0">
    <div
      class="document-tree-item-surface relative flex h-full w-full min-w-0 items-center gap-1 p-0"
      :class="[
        itemStateClass,
        {
          'is-expandable': props.item.hasChildren,
          'is-selection-mode': props.selectionMode,
          'selected': props.checked,
        },
      ]"
    >
      <div class="flex min-w-0 flex-1 items-center gap-1.5 border-none bg-transparent p-0 text-left text-inherit">
        <SvgIcon
          v-if="!props.selectionMode"
          category="ui"
          :icon="treeIconName"
          class="shrink-0"
        />
        <span class="document-tree-item__title block min-w-0 flex-1 overflow-hidden text-[13px] leading-5 text-ellipsis whitespace-nowrap" :class="{ 'font-medium': itemStateClass === 'active' }">
          {{ props.item.title }}
        </span>
      </div>

      <div
        v-if="!props.selectionMode"
        class="document-tree-item__actions ml-auto flex items-center gap-px"
        :class="actionsStateClass"
        @click.stop
      >
        <ElButton
          v-if="canManageDocument"
          text
          class="document-tree-item__icon-button ml-0 h-5 min-w-5 w-5 rounded-md p-0"
          :class="itemStateClass"
          :disabled="isActionPending"
          :title="t('docs.common.createChildDocument')"
          @click.stop="createChild"
        >
          <SvgIcon category="ui" icon="plus" size="14px" />
        </ElButton>

        <ElDropdown
          trigger="click"
          popper-class="document-tree-item__menu-popper"
          @command="handleMenuCommand"
        >
          <ElButton
            text
            class="document-tree-item__icon-button ml-0 h-5 min-w-5 w-5 rounded-md p-0"
            data-testid="document-tree-item-menu-trigger"
            :class="itemStateClass"
            :disabled="isActionPending"
            :title="t('docs.common.moreActions')"
            @click.stop
          >
            <SvgIcon category="ui" icon="more" size="14px" />
          </ElButton>

          <template #dropdown>
            <ElDropdownMenu class="document-tree-item__menu box-border min-w-0 w-36 p-1">
              <ElDropdownItem
                v-for="menuItem in menuItems"
                :key="menuItem.command"
                :command="menuItem.command"
                :divided="menuItem.divided"
                class="document-tree-item__menu-item min-h-8 w-full box-border gap-1.5 rounded-lg px-2 text-sm text-main"
                :class="{
                  'document-tree-item__menu-item--delete text-error': menuItem.danger,
                  'my-1': menuItem.divided,
                }"
              >
                <template #icon>
                  <span
                    class="inline-flex h-4 w-4 flex-none items-center justify-center"
                    :class="menuItem.danger
                      ? 'text-[color-mix(in_srgb,var(--brand-error)_80%,var(--brand-text-secondary))]'
                      : 'text-[color-mix(in_srgb,var(--brand-text-secondary)_86%,transparent)]'"
                  >
                    <SvgIcon category="ui" :icon="menuItem.icon" />
                  </span>
                </template>
                {{ menuItem.label }}
              </ElDropdownItem>
            </ElDropdownMenu>
          </template>
        </ElDropdown>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.document-tree-item {
  .document-tree-item-surface {
    transition:
      color 0.2s ease,
      opacity 0.2s ease;

    &.active {
      color: var(--brand-primary);

      :deep(.el-button) {
        --el-button-border-color: transparent;
        --el-button-hover-bg-color: transparent;
        --el-button-hover-text-color: var(--brand-primary);
        --el-button-active-bg-color: transparent;
        --el-button-active-text-color: var(--brand-primary);
        --el-button-outline-color: transparent;
        --el-button-hover-border-color: transparent;
        --el-button-active-border-color: transparent;
        box-shadow: none;
      }
    }

    &.idle {
      &:hover {
        color: var(--brand-text-primary);
      }
    }

    .document-tree-item__icon-button {
      --el-button-text-color: var(--brand-text-secondary);
      --el-button-border-color: transparent;
      --el-button-hover-border-color: transparent;
      --el-button-active-border-color: transparent;
      --el-button-hover-text-color: var(--brand-primary);
      --el-button-active-text-color: var(--brand-primary);
      --el-button-hover-bg-color: var(--brand-bg-surface-raised);
      --el-button-active-bg-color: var(--brand-bg-surface-raised);
      color: var(--brand-text-secondary);
      box-shadow: none;

      &:disabled {
        opacity: 0.3;
      }

      &.active {
        --el-button-hover-bg-color: transparent;
        --el-button-active-bg-color: transparent;
        color: var(--brand-primary);
      }

      &.idle {
        &:hover {
          color: var(--brand-primary);
          background: var(--brand-bg-surface-raised);
        }
      }
    }

    .document-tree-item__actions {
      transition: opacity 0.2s ease;

      &.visible {
        opacity: 1;
      }

      &.hidden {
        pointer-events: none;
        opacity: 0;
      }
    }

    &:hover .document-tree-item__actions.hidden,
    &:focus-within .document-tree-item__actions.hidden {
      pointer-events: auto;
      opacity: 1;
    }
  }
}

:global(.document-tree-item__menu-popper) {
  --el-dropdown-menuItem-hover-color: var(--brand-text-primary);
  --el-dropdown-menuItem-hover-fill: color-mix(in srgb, var(--brand-fill-lighter) 76%, var(--brand-text-primary) 6%);
}

:global(.document-tree-item__menu-popper .el-dropdown-menu__item--divided) {
  border-top-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
}

:global(.document-tree-item__menu-popper .el-dropdown-menu__item:not(.is-disabled):focus:not(:focus-visible):not(:hover)) {
  background-color: transparent;
  color: var(--brand-text-primary);
}

:global(.document-tree-item__menu-popper .el-dropdown-menu__item.document-tree-item__menu-item--delete:not(.is-disabled):hover),
:global(.document-tree-item__menu-popper .el-dropdown-menu__item.document-tree-item__menu-item--delete:not(.is-disabled):focus) {
  background: color-mix(in srgb, var(--brand-error) 9%, white);
  color: var(--brand-error);
}
</style>
