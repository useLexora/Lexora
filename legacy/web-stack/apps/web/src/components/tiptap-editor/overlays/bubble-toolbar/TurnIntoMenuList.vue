<script setup lang="ts">
import type { TurnIntoMenuItem } from '../catalog/menuRegistry'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import MenuGlyph from '../shared/MenuGlyph.vue'

/**
 * 文本转换列表属性。
 */
interface TurnIntoMenuListProps {
  /** 菜单项列表 */
  items: TurnIntoMenuItem[]
}

/**
 * 文本转换列表事件。
 */
interface TurnIntoMenuListEmits {
  select: [item: TurnIntoMenuItem]
}

defineProps<TurnIntoMenuListProps>()
const emits = defineEmits<TurnIntoMenuListEmits>()
</script>

<template>
  <button
    v-for="item in items"
    :key="item.label"
    type="button"
    class="tiptap-turn-into-menu__item"
    :class="{ 'is-active': item.isActive }"
    @mousedown.prevent
    @click="emits('select', item)"
  >
    <span class="tiptap-turn-into-menu__icon">
      <MenuGlyph :icon="item.icon" :fallback-text="item.icon" />
    </span>
    <span class="tiptap-turn-into-menu__label">{{ item.label }}</span>
    <TiptapIcon
      v-if="item.isActive"
      icon="check"
      size="0.875rem"
      class="tiptap-turn-into-menu__check"
    />
  </button>
</template>
