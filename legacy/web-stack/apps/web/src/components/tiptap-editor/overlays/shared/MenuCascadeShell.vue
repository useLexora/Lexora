<script setup lang="ts">
/**
 * 级联菜单壳层属性。
 */
interface MenuCascadeShellProps {
  /** 是否显示二级面板 */
  showSubmenu?: boolean
  /** 壳层附加类名 */
  shellClass?: string
  /** 二级面板附加类名 */
  submenuClass?: string
}

withDefaults(defineProps<MenuCascadeShellProps>(), {
  showSubmenu: false,
  shellClass: '',
  submenuClass: '',
})
</script>

<template>
  <div class="tiptap-menu-cascade-shell" :class="shellClass">
    <slot name="root" />

    <div
      v-if="showSubmenu"
      class="tiptap-menu-cascade-shell__submenu"
      :class="submenuClass"
    >
      <slot name="submenu" />
    </div>
  </div>
</template>
