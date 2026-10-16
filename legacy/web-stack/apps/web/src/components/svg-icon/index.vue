<script lang="ts" setup>
import type { SvgIconProps } from './typing'
import { computed } from 'vue'
import { SvgIconCategory } from './typing'

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<SvgIconProps>(), {
  category: SvgIconCategory.UI,
  color: 'currentColor',
  size: '1em',
})
defineEmits(['click'])

const symbolHref = computed(() => `/icon-${props.category}.svg#${props.icon}`)
const calculateSize = computed(() => {
  const size = typeof props.size === 'string'
    ? [props.size]
    : props.size

  return {
    width: size[0],
    height: size[1] || size[0],
  }
})
</script>

<template>
  <svg
    class="select-none outline-none"
    v-bind="$attrs"
    role="presentation"
    aria-hidden="true"
    :width="calculateSize.width"
    :height="calculateSize.height"
    :style="{ verticalAlign: 'middle', color }"
    @click="$emit('click')"
  >
    <use :href="symbolHref" />
  </svg>
</template>
