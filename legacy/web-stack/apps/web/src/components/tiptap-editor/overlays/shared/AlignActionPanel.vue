<script setup lang="ts">
import type { BlockMenuChildItem } from '../catalog/menuRegistry'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import MenuGlyph from './MenuGlyph.vue'

/**
 * 对齐面板属性。
 */
interface AlignActionPanelProps {
  /** 对齐项 */
  items: BlockMenuChildItem[]
}

/**
 * 对齐面板事件。
 */
interface AlignActionPanelEmits {
  itemClick: [item: BlockMenuChildItem]
}

defineProps<AlignActionPanelProps>()
const emits = defineEmits<AlignActionPanelEmits>()
</script>

<template>
  <div class="tiptap-align-menu">
    <button
      v-for="item in items"
      :key="item.label"
      class="tiptap-align-menu__item"
      :class="{ 'is-active': item.kind === 'text-align' && item.isActive }"
      :disabled="item.kind === 'indent' && item.disabled"
      type="button"
      @mousedown.prevent
      @click="emits('itemClick', item)"
    >
      <span class="tiptap-align-menu__icon">
        <MenuGlyph :icon="item.icon" :fallback-text="item.label.slice(0, 1)" />
      </span>
      <span class="tiptap-align-menu__label">{{ item.label }}</span>
      <TiptapIcon
        v-if="item.kind === 'text-align' && item.isActive"
        icon="check"
        size="0.875rem"
        class="tiptap-align-menu__check"
      />
    </button>
  </div>
</template>
