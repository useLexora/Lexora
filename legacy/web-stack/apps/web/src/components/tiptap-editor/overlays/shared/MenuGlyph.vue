<script setup lang="ts">
import { computed } from 'vue'
import TiptapIcon from '../../icons/TiptapIcon.vue'

/** 菜单图标属性。 */
interface MenuGlyphProps {
  icon: string
  fallbackText?: string
}

const props = defineProps<MenuGlyphProps>()

const MENU_GLYPH_ICON_REGISTRY: Record<string, string> = {
  'T': 'turn-into-paragraph',
  'H1': 'turn-into-heading-1',
  'H2': 'turn-into-heading-2',
  'H3': 'turn-into-heading-3',
  'H4': 'turn-into-heading-4',
  'H5': 'turn-into-heading-5',
  'H+': 'turn-into-heading-more',
  'list-ul': 'list-bulleted',
  'list-ol': 'list-numbered',
  'code': 'code',
  'math-block': 'math-block',
  'inline-math': 'inline-math',
  'Σ': 'math-block',
  '√x': 'inline-math',
  'quote': 'quotes',
  'task': 'task',
  'link': 'link',
  'image': 'image',
  'file': 'file',
  'edit': 'edit',
  'comment': 'comment',
  '+': 'plus',
  'align': 'align-left',
  'align-left': 'align-left',
  'align-center': 'align-center',
  'align-right': 'align-right',
  'indent': 'indent',
  'outdent': 'outdent',
  'color': 'color',
  'copy': 'copy',
  'cut': 'cut',
  'delete': 'trash-can',
}

const iconName = computed(() => {
  return MENU_GLYPH_ICON_REGISTRY[props.icon] ?? null
})

const text = computed(() => props.fallbackText ?? props.icon)
</script>

<template>
  <TiptapIcon
    v-if="iconName"
    :icon="iconName"
    class="tiptap-menu-glyph__icon"
  />

  <span v-else-if="icon === 'divider'" class="tiptap-menu-glyph__divider" />

  <span v-else class="tiptap-menu-glyph__text">{{ text }}</span>
</template>
