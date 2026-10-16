<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { backgroundColorOptions, textColorOptions } from '../catalog/menuRegistry'

/**
 * 颜色面板属性。
 */
interface EditorColorPanelProps {
  /** 当前文字颜色 */
  textColor: string
  /** 当前背景颜色 */
  backgroundColor: string
  /** 是否展示返回按钮 */
  showBackButton?: boolean
}

/**
 * 颜色面板事件。
 */
interface EditorColorPanelEmits {
  back: []
  applyTextColor: [color: string]
  applyBackgroundColor: [color: string]
}

const props = withDefaults(defineProps<EditorColorPanelProps>(), {
  showBackButton: false,
})
const emits = defineEmits<EditorColorPanelEmits>()
const { t } = useI18n({ useScope: 'global' })

function isActiveTextColor(color: string) {
  return color ? props.textColor === color : !props.textColor
}

function isActiveBackgroundColor(color: string) {
  return color ? props.backgroundColor === color : !props.backgroundColor
}

function resetAllColors() {
  emits('applyTextColor', '')
  emits('applyBackgroundColor', '')
}

function getColorLabel(className: string) {
  if (!className) {
    return t('editor.colors.default')
  }

  if (className.includes('gray')) {
    return t('editor.colors.gray')
  }
  if (className.includes('brown')) {
    return t('editor.colors.brown')
  }
  if (className.includes('orange')) {
    return t('editor.colors.orange')
  }
  if (className.includes('yellow')) {
    return t('editor.colors.yellow')
  }
  if (className.includes('green')) {
    return t('editor.colors.green')
  }
  if (className.includes('blue')) {
    return t('editor.colors.blue')
  }
  if (className.includes('purple')) {
    return t('editor.colors.purple')
  }
  if (className.includes('pink')) {
    return t('editor.colors.pink')
  }

  return t('editor.colors.red')
}
</script>

<template>
  <div class="tiptap-color-picker">
    <button
      v-if="showBackButton"
      type="button"
      class="tiptap-color-picker__back"
      @mousedown.prevent
      @click="emits('back')"
    >
      {{ t('editor.common.back') }}
    </button>

    <div class="tiptap-color-picker__section-title">
      {{ t('editor.common.textColor') }}
    </div>
    <div class="tiptap-color-picker__grid">
      <button
        v-for="item in textColorOptions"
        :key="`text-${item.className}`"
        class="tiptap-color-picker__swatch is-text"
        :class="{ 'is-active': isActiveTextColor(item.className), 'is-default': !item.className }"
        :title="getColorLabel(item.className)"
        type="button"
        @mousedown.prevent
        @click="emits('applyTextColor', item.className)"
      >
        <span class="tiptap-color-picker__swatch-preview">
          <span
            class="tiptap-color-picker__swatch-label"
            :class="item.className"
          >A</span>
        </span>
      </button>
    </div>

    <div class="tiptap-color-picker__section-title">
      {{ t('editor.common.backgroundColor') }}
    </div>
    <div class="tiptap-color-picker__grid">
      <button
        v-for="item in backgroundColorOptions"
        :key="`bg-${item.className}`"
        class="tiptap-color-picker__swatch"
        :class="[
          { 'is-active': isActiveBackgroundColor(item.className), 'is-default': !item.className },
          item.className,
        ]"
        :title="getColorLabel(item.className)"
        type="button"
        @mousedown.prevent
        @click="emits('applyBackgroundColor', item.className)"
      >
        <span class="tiptap-color-picker__swatch-preview">
          <span class="tiptap-color-picker__swatch-label">A</span>
        </span>
      </button>
    </div>

    <div class="tiptap-color-picker__footer">
      <button
        class="tiptap-color-picker__reset"
        type="button"
        @mousedown.prevent
        @click="resetAllColors"
      >
        {{ t('editor.common.resetAll') }}
      </button>
    </div>
  </div>
</template>
