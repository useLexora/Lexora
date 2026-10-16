<script setup lang="ts">
import { computed } from 'vue'
import BubbleToolbarButton from './BubbleToolbarButton.vue'

/**
 * 气泡工具栏下拉壳层属性。
 */
interface BubbleDropdownShellProps {
  /** 是否展开 */
  visible: boolean
  /** 弹层宽度 */
  width: number
  /** 弹层样式类 */
  popperClass: string
  /** 提示描述 */
  description?: string
  /** 按钮是否高亮 */
  active?: boolean
}

/**
 * 气泡工具栏下拉壳层事件。
 */
interface BubbleDropdownShellEmits {
  'update:visible': [visible: boolean]
}

const props = withDefaults(defineProps<BubbleDropdownShellProps>(), {
  description: undefined,
  active: false,
})
const emits = defineEmits<BubbleDropdownShellEmits>()
const visibleModel = computed({
  get: () => props.visible,
  set: value => emits('update:visible', value),
})
</script>

<template>
  <ElPopover
    v-model:visible="visibleModel"
    trigger="click"
    placement="bottom-start"
    :offset="6"
    :show-arrow="false"
    :width="width"
    :popper-class="popperClass"
  >
    <template #reference>
      <BubbleToolbarButton
        :description="description"
        :active="active"
        button-variant="dropdown"
        @mousedown.prevent
      >
        <slot name="trigger" />
      </BubbleToolbarButton>
    </template>

    <slot />
  </ElPopover>
</template>
