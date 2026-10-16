<script setup lang="ts">
import { useAttrs } from 'vue'

defineOptions({
  inheritAttrs: false,
})

withDefaults(defineProps<BubbleToolbarButtonProps>(), {
  description: undefined,
  active: false,
  disabled: false,
  buttonVariant: 'default',
})

/**
 * 气泡工具栏按钮属性。
 */
interface BubbleToolbarButtonProps {
  /** 提示描述 */
  description?: string
  /** 是否高亮 */
  active?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 按钮形态 */
  buttonVariant?: 'default' | 'wide' | 'dropdown'
}

const attrs = useAttrs()
</script>

<template>
  <span class="tiptap-bubble-tooltip-trigger">
    <ElTooltip
      v-if="description"
      :content="description"
      effect="dark"
      placement="top"
    >
      <button
        v-bind="attrs"
        class="tiptap-bubble-btn"
        :class="{
          'is-active': active,
          'tiptap-bubble-btn--wide': buttonVariant === 'wide',
          'tiptap-bubble-btn--dropdown': buttonVariant === 'dropdown',
        }"
        :disabled="disabled"
        type="button"
      >
        <slot />
      </button>
    </ElTooltip>
    <button
      v-else
      v-bind="attrs"
      class="tiptap-bubble-btn"
      :class="{
        'is-active': active,
        'tiptap-bubble-btn--wide': buttonVariant === 'wide',
        'tiptap-bubble-btn--dropdown': buttonVariant === 'dropdown',
      }"
      :disabled="disabled"
      type="button"
    >
      <slot />
    </button>
  </span>
</template>
