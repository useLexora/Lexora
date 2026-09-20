<script setup lang="ts">
import type { Component } from 'vue'
import type { DesktopIconName } from './desktopIcons'
import { NIcon } from 'naive-ui'
import { computed } from 'vue'
import { DESKTOP_ICON_URLS } from './desktopIcons'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  name?: DesktopIconName
  component?: Component
  size?: number | string
  color?: string
}>()

const maskStyle = computed(() => ({
  '--desktop-icon-mask': props.name ? `url("${DESKTOP_ICON_URLS[props.name]}")` : undefined,
  'color': props.color,
  'fontSize': typeof props.size === 'number' ? `${props.size}px` : props.size,
}))
</script>

<template>
  <!-- n-icon：与 Fluent 图标共用 naive 的图标字号规则，例如下拉菜单的 --n-option-icon-size -->
  <span
    v-if="name"
    class="desktop-icon n-icon"
    :style="maskStyle"
    aria-hidden="true"
    v-bind="$attrs"
  />
  <NIcon v-else :component="component" :size="size" :color="color" v-bind="$attrs">
    <slot />
  </NIcon>
</template>

<style scoped>
.desktop-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  flex: none;
  background-color: currentColor;
  mask: var(--desktop-icon-mask) center / contain no-repeat;
  mask-mode: alpha;
  -webkit-mask: var(--desktop-icon-mask) center / contain no-repeat;
}
</style>
