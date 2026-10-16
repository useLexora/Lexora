<script setup lang="ts">
import type { BlockMenuChildItem, BlockMenuItem, BlockMenuQuickItem, BlockTriggerViewState } from '../catalog/menuRegistry'
import type { LinkPanelController } from '../shared/useLinkPanel'
import type { BlockTriggerPanel } from './useBlockTriggerOverlay'
import AlignActionPanel from '../shared/AlignActionPanel.vue'
import EditorColorPanel from '../shared/EditorColorPanel.vue'
import LinkPanel from '../shared/LinkPanel.vue'
import MenuCascadeShell from '../shared/MenuCascadeShell.vue'
import BlockTriggerRootPanel from './BlockTriggerRootPanel.vue'

/**
 * 块触发面板属性。
 */
interface BlockTriggerPanelsProps {
  /** 视图状态 */
  state: BlockTriggerViewState
  /** 当前激活面板 */
  activePanel: BlockTriggerPanel
  /** 链接面板控制器 */
  linkPanel: LinkPanelController
}

/**
 * 块触发面板事件。
 */
interface BlockTriggerPanelsEmits {
  quickItemClick: [item: BlockMenuQuickItem]
  menuItemClick: [item: BlockMenuItem]
  alignItemClick: [item: BlockMenuChildItem]
  applyTextColor: [color: string]
  applyBackgroundColor: [color: string]
}

defineProps<BlockTriggerPanelsProps>()
const emits = defineEmits<BlockTriggerPanelsEmits>()
</script>

<template>
  <MenuCascadeShell :show-submenu="activePanel !== 'root'" submenu-class="tiptap-block-trigger-submenu-shell">
    <template #root>
      <BlockTriggerRootPanel
        :state="state"
        :active-panel="activePanel"
        @quick-item-click="emits('quickItemClick', $event)"
        @menu-item-click="emits('menuItemClick', $event)"
      />
    </template>

    <template #submenu>
      <AlignActionPanel
        v-if="activePanel === 'align'"
        :items="state.alignItems"
        @item-click="emits('alignItemClick', $event)"
      />

      <EditorColorPanel
        v-else-if="activePanel === 'color'"
        :text-color="state.currentTextColor"
        :background-color="state.currentBackgroundColor"
        @apply-text-color="emits('applyTextColor', $event)"
        @apply-background-color="emits('applyBackgroundColor', $event)"
      />

      <LinkPanel v-else :controller="linkPanel" />
    </template>
  </MenuCascadeShell>
</template>
