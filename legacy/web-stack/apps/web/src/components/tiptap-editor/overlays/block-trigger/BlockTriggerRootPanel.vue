<script setup lang="ts">
import type {
  BlockMenuItem,
  BlockMenuQuickItem,
  BlockMenuTurnIntoQuickItem,
  BlockTriggerViewState,
} from '../catalog/menuRegistry'
import type { BlockTriggerPanel } from './useBlockTriggerOverlay'
import { computed } from 'vue'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import { groupBlockTurnIntoQuickItems } from '../catalog/menuRegistry'
import MenuGlyph from '../shared/MenuGlyph.vue'

interface BlockTriggerRootListItem {
  key: string
  label: string
  icon: string
  isActive: boolean
  showChevron: boolean
  handleClick: () => void
}

interface BlockTriggerQuickRow {
  key: string
  items: BlockMenuTurnIntoQuickItem[]
}

/** 块触发根面板属性。 */
interface BlockTriggerRootPanelProps {
  /** 视图状态 */
  state: BlockTriggerViewState
  /** 当前激活面板 */
  activePanel: BlockTriggerPanel
}

/** 块触发根面板事件。 */
interface BlockTriggerRootPanelEmits {
  quickItemClick: [item: BlockMenuQuickItem]
  menuItemClick: [item: BlockMenuItem]
}

const props = defineProps<BlockTriggerRootPanelProps>()
const emits = defineEmits<BlockTriggerRootPanelEmits>()

const turnIntoRows = computed<BlockTriggerQuickRow[]>(() =>
  groupBlockTurnIntoQuickItems(props.state.model.quickItems).map((items, index) => ({
    key: `quick-row-${index}`,
    items,
  })),
)

const insertItems = computed(() =>
  props.state.model.quickItems.filter(item => item.kind !== 'turn-into'),
)

const listItems = computed<BlockTriggerRootListItem[]>(() => [
  ...insertItems.value.map(item => ({
    key: `quick-${item.kind}`,
    label: item.label,
    icon: item.icon,
    isActive: item.kind === 'insert-link' && props.activePanel === 'link',
    showChevron: item.kind === 'insert-link',
    handleClick: () => emits('quickItemClick', item),
  })),
  ...props.state.model.menuItems.map(item => ({
    key: `menu-${item.kind}-${item.action}`,
    label: item.label,
    icon: item.icon,
    isActive: item.kind === 'panel' && props.activePanel === item.action,
    showChevron: item.kind === 'panel',
    handleClick: () => emits('menuItemClick', item),
  })),
])
</script>

<template>
  <div class="tiptap-block-trigger-menu">
    <div class="tiptap-block-trigger-menu__quick-grid">
      <div
        v-for="row in turnIntoRows"
        :key="row.key"
        class="tiptap-block-trigger-menu__quick-row"
      >
        <button
          v-for="item in row.items"
          :key="item.label"
          class="tiptap-block-trigger-menu__quick-item"
          :class="{ 'is-active': item.isActive }"
          :title="item.label"
          type="button"
          @mousedown.prevent
          @click="emits('quickItemClick', item)"
        >
          <span class="tiptap-block-trigger-menu__quick-icon">
            <MenuGlyph :icon="item.icon" :fallback-text="item.label.slice(0, 2)" />
          </span>
        </button>
      </div>
    </div>

    <div v-if="listItems.length" class="tiptap-block-trigger-menu__divider" />

    <div v-if="listItems.length" class="tiptap-block-trigger-menu__list">
      <button
        v-for="item in listItems"
        :key="item.key"
        class="tiptap-block-trigger-menu__list-item"
        :class="{ 'is-active': item.isActive }"
        type="button"
        @mousedown.prevent
        @click="item.handleClick()"
      >
        <span class="tiptap-block-trigger-menu__list-icon">
          <MenuGlyph :icon="item.icon" :fallback-text="item.label.slice(0, 1)" />
        </span>
        <span class="tiptap-block-trigger-menu__list-label">{{ item.label }}</span>
        <TiptapIcon
          v-if="item.showChevron"
          icon="chevron-right"
          size="0.875rem"
          class="tiptap-block-trigger-menu__chevron"
        />
      </button>
    </div>
  </div>
</template>
