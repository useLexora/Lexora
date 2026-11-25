<script setup lang="ts">
import type { BuddyTextQuote } from '@buddy-shared/conversation/buddyUserContent'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { PrepareResourceQuote } from '@/shared/ui/selection/useResourceSelectionQuote'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { loadDesktopMonaco, observeDesktopMonacoTheme } from '@/shared/ui/monaco/desktopMonaco'
import { revealMonacoQuote } from '@/shared/ui/selection/revealMonacoQuote'
import { registerMonacoResourceQuote } from '@/shared/ui/selection/useMonacoResourceQuote'
import { renderMonacoFind } from './monacoDocumentFind'
import './documentFind.css'

const props = withDefaults(defineProps<{ text: string, path: string, wrap: boolean, language: 'zh-CN' | 'en-US', quoteSource?: BuddyTextQuote['source'], prepareQuote?: PrepareResourceQuote, findOpen?: boolean, findQuery?: string, findIndex?: number }>(), { findOpen: false, findQuery: '', findIndex: 0 })
const emit = defineEmits<{ findResult: [result: { count: number, capped: boolean }] }>()
const { t } = useBuddyI18n(() => props.language)
const activeEditor = shallowRef<Monaco.editor.IStandaloneCodeEditor>()
let findDecorations: Monaco.editor.IEditorDecorationsCollection | null = null
function applyMonacoFind() {
  const editor = activeEditor.value
  if (!editor || !props.findOpen) {
    findDecorations?.clear()
    return
  }
  const rendered = renderMonacoFind(editor, props.findQuery, props.findIndex, true, findDecorations)
  findDecorations = rendered.collection
  emit('findResult', { count: rendered.count, capped: rendered.capped })
}
defineExpose({ ready: computed(() => !!activeEditor.value), reveal: (quote: BuddyTextQuote) => !!activeEditor.value && revealMonacoQuote(activeEditor.value, quote) })
const container = useTemplateRef<HTMLElement>('container')
const failed = shallowRef(false)
watch([activeEditor, () => props.findOpen, () => props.findQuery, () => props.findIndex], () => applyMonacoFind(), { flush: 'post' })
const languages: Record<string, string> = {
  css: 'css',
  html: 'html',
  vue: 'html',
  svelte: 'html',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'javascript',
  jsonc: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  ps1: 'powershell',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}
watch(container, async (element, _previous, onCleanup) => {
  let active = true
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined
  let model: Monaco.editor.ITextModel | undefined
  let stopTheme: (() => void) | undefined
  let stopUpdates: (() => void) | undefined
  function dispose() {
    stopUpdates?.()
    stopTheme?.()
    if (activeEditor.value === editor)
      activeEditor.value = undefined
    editor?.dispose()
    model?.dispose()
  }
  onCleanup(() => {
    active = false
    dispose()
  })
  if (!element)
    return
  failed.value = false
  try {
    const monaco = await loadDesktopMonaco()
    if (!active)
      return
    model = monaco.editor.createModel(props.text, 'plaintext')
    editor = monaco.editor.create(element, {
      model,
      automaticLayout: true,
      readOnly: true,
      domReadOnly: true,
      contextmenu: true,
      fontSize: 12,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      renderLineHighlight: 'none',
      padding: { top: 8, bottom: 8 },
    })
    if (props.quoteSource && props.prepareQuote)
      registerMonacoResourceQuote(editor, { label: () => t('desktop.chat.quoteSelection'), source: () => props.quoteSource!, prepare: (...args) => props.prepareQuote?.(...args) ?? null })
    activeEditor.value = editor
    stopTheme = observeDesktopMonacoTheme(monaco, editor)
    stopUpdates = watch(() => [props.text, props.path, props.wrap] as const, ([text, path, wrap], previous) => {
      if (!editor || !model)
        return
      if (model.getValue() !== text)
        model.setValue(text)
      monaco.editor.setModelLanguage(model, languages[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'plaintext')
      editor.updateOptions({ wordWrap: wrap ? 'on' : 'off' })
      if (path !== previous?.[1])
        editor.setScrollTop(0)
      if (!previous || text !== previous[0] || path !== previous[1])
        applyMonacoFind()
    }, { immediate: true })
  }
  catch {
    dispose()
    if (active)
      failed.value = true
  }
}, { immediate: true })
</script>

<template>
  <div class="desktop-monaco-file relative w-full h-full min-w-0 min-h-0">
    <div ref="container" class="w-full h-full" />
    <div v-if="failed" class="absolute inset-0 grid place-items-center text-muted bg-surface">
      <slot name="error" />
    </div>
  </div>
</template>
