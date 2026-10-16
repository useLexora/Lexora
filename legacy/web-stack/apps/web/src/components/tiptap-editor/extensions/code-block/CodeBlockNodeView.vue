<script setup lang="ts">
import type { CodeBlockLanguage } from './languages'
import {
  TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE,
  TIPTAP_CODE_BLOCK_TAB_SIZES,
} from '@haohaoxue/lexora-contracts/tiptap/document-body'
import { NodeViewContent, nodeViewProps, NodeViewWrapper } from '@tiptap/vue-3'
import { useClipboard } from '@vueuse/core'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CopyStateIcon from '@/components/copy-state-icon/CopyStateIcon.vue'
import { ElMessage } from '@/utils/element-plus'
import TiptapIcon from '../../icons/TiptapIcon.vue'
import {
  CODE_BLOCK_LANGUAGES,
  resolveCodeBlockLanguage,
} from './languages'
import { ensureCodeBlockLanguageAndRefresh } from './lowlight'
import { useCodeBlockLineNumbers } from './useCodeBlockLineNumbers'

const props = defineProps(nodeViewProps)
const { t } = useI18n()

const CODE_BLOCK_TAB_SIZE_OPTIONS = TIPTAP_CODE_BLOCK_TAB_SIZES.map(size => ({
  label: size,
  value: size,
}))

const titleInputRef = useTemplateRef<HTMLInputElement>('titleInput')
const bodyRef = useTemplateRef<HTMLElement>('codeBlockBody')
const isTitleEditing = shallowRef(false)
const titleDraft = shallowRef('')
const languageQuery = shallowRef('')
const languagePopoverVisible = shallowRef(false)
const morePopoverVisible = shallowRef(false)
const readonlyCollapsed = shallowRef<boolean | null>(null)
const showLineNumbers = shallowRef(true)
const wrapLines = shallowRef(false)
const {
  copy: copyCodeText,
  copied,
  isSupported: isClipboardSupported,
} = useClipboard({
  copiedDuring: 1400,
  legacy: true,
})

const selectedLanguage = computed(() => resolveCodeBlockLanguage(props.node.attrs.language))
const isEditable = computed(() => props.editor.isEditable)

watch(
  () => selectedLanguage.value.highlightLanguage,
  (highlightLanguage) => {
    void ensureCodeBlockLanguageAndRefresh(props.editor, highlightLanguage)
  },
  {
    immediate: true,
  },
)
const codeBlockName = computed(() => normalizeCodeBlockName(props.node.attrs.name))
const displayTitle = computed(() => codeBlockName.value ?? t('editor.codeBlock.defaultTitle'))
const isCollapsed = computed(() => readonlyCollapsed.value ?? props.node.attrs.collapsed === true)
const collapseIcon = computed(() => isCollapsed.value ? 'chevron-right' : 'chevron-down')
const tabSize = computed(() => normalizeCodeBlockTabSize(props.node.attrs.tabSize))
const isToolbarActive = computed(() => languagePopoverVisible.value || morePopoverVisible.value)
const codeBlockStyle = computed(() => ({
  '--tiptap-code-block-tab-size': String(tabSize.value),
}))
const codeText = computed(() => props.node.textContent)
const { lineNumberRows } = useCodeBlockLineNumbers({
  bodyRef,
  codeText,
  isCollapsed,
  showLineNumbers,
  tabSize,
  wrapLines,
})
const filteredLanguages = computed(() => {
  const keyword = languageQuery.value.trim().toLowerCase()

  if (!keyword) {
    return CODE_BLOCK_LANGUAGES
  }

  return CODE_BLOCK_LANGUAGES.filter(language => matchesLanguageKeyword(language, keyword))
})

function matchesLanguageKeyword(language: CodeBlockLanguage, keyword: string) {
  return language.id.includes(keyword)
    || language.label.toLowerCase().includes(keyword)
    || (language.aliases ?? []).some(alias => alias.toLowerCase().includes(keyword))
}

function normalizeCodeBlockName(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.replace(/\s+/g, ' ').trim()

  return normalized || undefined
}

function normalizePastedTitleText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeCodeBlockTabSize(value: unknown) {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE

  return TIPTAP_CODE_BLOCK_TAB_SIZES.includes(numberValue as typeof TIPTAP_CODE_BLOCK_TAB_SIZES[number])
    ? numberValue
    : TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE
}

function startTitleEditing() {
  if (!isEditable.value) {
    return
  }

  titleDraft.value = codeBlockName.value ?? ''
  isTitleEditing.value = true

  void nextTick(() => {
    titleInputRef.value?.focus()
    titleInputRef.value?.select()
  })
}

function commitTitle() {
  if (!isTitleEditing.value) {
    return
  }

  const name = normalizeCodeBlockName(titleDraft.value)
  isTitleEditing.value = false
  titleDraft.value = ''

  if (name === codeBlockName.value) {
    return
  }

  if (!isEditable.value) {
    return
  }

  props.updateAttributes({
    name,
  })
}

function cancelTitleEditing() {
  isTitleEditing.value = false
  titleDraft.value = ''
}

function handleTitleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitTitle()
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    cancelTitleEditing()
  }
}

function handleTitlePaste(event: ClipboardEvent) {
  const pastedText = event.clipboardData?.getData('text/plain') ?? ''
  const normalizedText = normalizePastedTitleText(pastedText)

  event.preventDefault()

  if (!normalizedText) {
    return
  }

  const input = event.currentTarget instanceof HTMLInputElement
    ? event.currentTarget
    : null

  if (!input) {
    titleDraft.value += normalizedText
    return
  }

  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start

  titleDraft.value = `${input.value.slice(0, start)}${normalizedText}${input.value.slice(end)}`

  void nextTick(() => {
    input.setSelectionRange(start + normalizedText.length, start + normalizedText.length)
  })
}

function selectLanguage(language: CodeBlockLanguage) {
  if (!isEditable.value) {
    return
  }

  props.updateAttributes({
    language: language.id,
  })
  languagePopoverVisible.value = false
  languageQuery.value = ''
}

async function copyCode() {
  if (!isClipboardSupported.value) {
    ElMessage.error(t('editor.codeBlock.copiedUnsupported'))
    return
  }

  try {
    await copyCodeText(props.node.textContent)
  }
  catch {
    ElMessage.error(t('editor.common.copyFailed'))
  }
}

function toggleCollapsed() {
  const collapsed = !isCollapsed.value

  if (!isEditable.value) {
    readonlyCollapsed.value = collapsed
    return
  }

  props.updateAttributes({
    collapsed: collapsed ? true : undefined,
  })

  if (collapsed) {
    languagePopoverVisible.value = false
    morePopoverVisible.value = false
  }
}

function toggleLineNumbers() {
  showLineNumbers.value = !showLineNumbers.value
}

function setLineNumbers(value: string | number | boolean) {
  showLineNumbers.value = Boolean(value)
}

function toggleWrapLines() {
  wrapLines.value = !wrapLines.value
}

function setWrapLines(value: string | number | boolean) {
  wrapLines.value = Boolean(value)
}

function updateTabSize(value: string | number | boolean | undefined) {
  if (!isEditable.value) {
    return
  }

  const nextTabSize = normalizeCodeBlockTabSize(value)

  props.updateAttributes({
    tabSize: nextTabSize === TIPTAP_CODE_BLOCK_DEFAULT_TAB_SIZE ? undefined : nextTabSize,
  })
}

function showFormatPlaceholder() {
  ElMessage.info(t('editor.codeBlock.formatComingSoon'))
  morePopoverVisible.value = false
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="tiptap-code-block"
    :style="codeBlockStyle"
    :class="{
      'tiptap-code-block--line-numbers': showLineNumbers,
      'tiptap-code-block--wrap': wrapLines,
      'tiptap-code-block--collapsed': isCollapsed,
      'tiptap-code-block--readonly': !isEditable,
      'tiptap-code-block--toolbar-active': isToolbarActive,
    }"
  >
    <div class="tiptap-code-block__header" contenteditable="false">
      <div class="tiptap-code-block__title-area">
        <button
          class="tiptap-code-block__collapse-btn"
          type="button"
          :aria-label="isCollapsed ? t('editor.codeBlock.expand') : t('editor.codeBlock.collapse')"
          @click="toggleCollapsed"
          @mousedown.prevent
        >
          <TiptapIcon :icon="collapseIcon" />
        </button>

        <input
          v-if="isTitleEditing"
          ref="titleInput"
          v-model="titleDraft"
          class="tiptap-code-block__title-input"
          type="text"
          :placeholder="t('editor.codeBlock.titlePlaceholder')"
          @blur="commitTitle"
          @click.stop
          @keydown.stop="handleTitleKeydown"
          @mousedown.stop
          @paste="handleTitlePaste"
        >

        <button
          v-else-if="isEditable"
          class="tiptap-code-block__title-btn"
          :class="{ 'is-placeholder': !codeBlockName }"
          type="button"
          @click="startTitleEditing"
          @mousedown.prevent
        >
          {{ displayTitle }}
        </button>

        <span
          v-else
          class="tiptap-code-block__title-text"
          :class="{ 'is-placeholder': !codeBlockName }"
        >
          {{ displayTitle }}
        </span>
      </div>

      <div class="tiptap-code-block__toolbar">
        <template v-if="isCollapsed || !isEditable">
          <span class="tiptap-code-block__language-label">
            {{ selectedLanguage.label }}
          </span>

          <span class="tiptap-code-block__divider" />

          <ElTooltip :content="t('editor.common.copy')" placement="top">
            <button class="tiptap-code-block__icon-btn" type="button" @click="copyCode" @mousedown.prevent>
              <CopyStateIcon :copied="copied" />
            </button>
          </ElTooltip>
        </template>

        <template v-else>
          <ElPopover
            v-model:visible="languagePopoverVisible"
            trigger="click"
            placement="bottom-end"
            :offset="8"
            :show-arrow="false"
            :width="310"
            popper-class="tiptap-code-block-language-popper"
          >
            <template #reference>
              <button class="tiptap-code-block__language-btn" type="button" @mousedown.prevent>
                <span>{{ selectedLanguage.label }}</span>
                <TiptapIcon icon="chevron-down" class="tiptap-code-block__chevron" />
              </button>
            </template>

            <div class="tiptap-code-block-language-panel">
              <ElInput
                v-model="languageQuery"
                :placeholder="t('editor.codeBlock.searchLanguage')"
                size="small"
                clearable
              />

              <ElScrollbar class="tiptap-code-block-language-panel__list" max-height="360px">
                <button
                  v-for="language in filteredLanguages"
                  :key="language.id"
                  class="tiptap-code-block-language-panel__item"
                  :class="{ 'is-active': language.id === selectedLanguage.id }"
                  type="button"
                  @click="selectLanguage(language)"
                >
                  <span>{{ language.label }}</span>
                  <TiptapIcon
                    v-if="language.id === selectedLanguage.id"
                    icon="check"
                    class="tiptap-code-block-language-panel__check"
                  />
                </button>
              </ElScrollbar>
            </div>
          </ElPopover>

          <span class="tiptap-code-block__divider" />

          <ElTooltip :content="t('editor.common.copy')" placement="top">
            <button class="tiptap-code-block__icon-btn" type="button" @click="copyCode" @mousedown.prevent>
              <CopyStateIcon :copied="copied" />
            </button>
          </ElTooltip>

          <ElPopover
            v-model:visible="morePopoverVisible"
            trigger="click"
            placement="bottom-end"
            :offset="8"
            :show-arrow="false"
            :width="224"
            popper-class="tiptap-code-block-more-popper"
          >
            <template #reference>
              <button class="tiptap-code-block__icon-btn" type="button" @mousedown.prevent>
                <SvgIcon category="ui" icon="more" size="18px" />
              </button>
            </template>

            <div class="tiptap-code-block-more-panel">
              <div
                class="tiptap-code-block-more-panel__item tiptap-code-block-more-panel__item--switch"
                role="menuitemcheckbox"
                tabindex="0"
                :aria-checked="showLineNumbers"
                @click="toggleLineNumbers"
                @keydown.enter.prevent="toggleLineNumbers"
                @keydown.space.prevent="toggleLineNumbers"
              >
                <span>{{ t('editor.codeBlock.lineNumbers') }}</span>
                <ElSwitch
                  :model-value="showLineNumbers"
                  size="small"
                  @click.stop
                  @keydown.stop
                  @change="setLineNumbers"
                />
              </div>

              <div
                class="tiptap-code-block-more-panel__item tiptap-code-block-more-panel__item--switch"
                role="menuitemcheckbox"
                tabindex="0"
                :aria-checked="wrapLines"
                @click="toggleWrapLines"
                @keydown.enter.prevent="toggleWrapLines"
                @keydown.space.prevent="toggleWrapLines"
              >
                <span>{{ t('editor.codeBlock.wrapLines') }}</span>
                <ElSwitch
                  :model-value="wrapLines"
                  size="small"
                  @click.stop
                  @keydown.stop
                  @change="setWrapLines"
                />
              </div>

              <div class="tiptap-code-block-more-panel__item tiptap-code-block-more-panel__item--select" role="group" :aria-label="t('editor.codeBlock.tabSize')">
                <span>{{ t('editor.codeBlock.tabSize') }}</span>
                <ElSelect
                  class="tiptap-code-block-more-panel__select"
                  :model-value="tabSize"
                  size="small"
                  :teleported="false"
                  @mousedown.stop
                  @click.stop
                  @keydown.stop
                  @change="updateTabSize"
                >
                  <ElOption
                    v-for="option in CODE_BLOCK_TAB_SIZE_OPTIONS"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </ElSelect>
              </div>

              <button class="tiptap-code-block-more-panel__item" type="button" @click="showFormatPlaceholder">
                <span>{{ t('editor.codeBlock.format') }}</span>
              </button>
            </div>
          </ElPopover>
        </template>
      </div>
    </div>

    <div v-show="!isCollapsed" ref="codeBlockBody" class="tiptap-code-block__body">
      <div v-if="showLineNumbers" class="tiptap-code-block__line-numbers" contenteditable="false">
        <span
          v-for="lineNumberRow in lineNumberRows"
          :key="lineNumberRow.number"
          :style="lineNumberRow.style"
        >
          {{ lineNumberRow.number }}
        </span>
      </div>
      <pre class="tiptap-code-block__pre"><NodeViewContent as="code" class="tiptap-code-block__code" /></pre>
    </div>
  </NodeViewWrapper>
</template>
