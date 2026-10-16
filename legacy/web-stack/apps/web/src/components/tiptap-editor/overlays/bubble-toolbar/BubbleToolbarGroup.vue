<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import type { BubbleToolbarAction } from '../catalog/actionRegistry'
import type { BubbleToolbarViewGroup } from '../catalog/bubbleToolbarCatalog'
import BubbleToolbarItem from './BubbleToolbarItem.vue'

/** 选择工具栏分组属性。 */
interface BubbleToolbarGroupProps {
  /** 编辑器实例 */
  editor: Editor
  /** 分组视图数据 */
  group: BubbleToolbarViewGroup
}

/** 选择工具栏分组事件。 */
interface BubbleToolbarGroupEmits {
  actionClick: [action: BubbleToolbarAction]
}

defineProps<BubbleToolbarGroupProps>()
const emits = defineEmits<BubbleToolbarGroupEmits>()
</script>

<template>
  <div class="tiptap-bubble-toolbar__group" :data-group="group.key">
    <div class="tiptap-bubble-toolbar__items">
      <BubbleToolbarItem
        v-for="item in group.items"
        :key="item.kind === 'action' ? item.action : item.component"
        :editor="editor"
        :item="item"
        @action-click="emits('actionClick', $event)"
      />
    </div>
  </div>
</template>
