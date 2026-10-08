<script setup lang="ts">
import type { BuddyResourceQuote, BuddyTextQuote } from '@buddy-shared/conversation/buddyUserContent'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { SelectionReferenceEditSource } from '@/shared/ui/selection/workbenchSelectionReferences'
import { shallowRef, useTemplateRef, watch } from 'vue'
import { loadDesktopMonaco, observeDesktopMonacoTheme } from '@/shared/ui/monaco/desktopMonaco'
import { registerMonacoResourceQuote } from '@/shared/ui/selection/useMonacoResourceQuote'

const props = defineProps<{ text: string, path: string, wrap: boolean, quoteSource?: BuddyTextQuote['source'], prepareQuote?: (quote: BuddyResourceQuote, x: number, y: number, isEditable?: boolean, editSource?: SelectionReferenceEditSource) => (() => void) | null }>()
const container = useTemplateRef<HTMLElement>('container')
const failed = shallowRef(false)
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
      contextmenu: false,
      fontSize: 12,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      renderLineHighlight: 'none',
      padding: { top: 8, bottom: 8 },
    })
    if (props.quoteSource && props.prepareQuote) {
      registerMonacoResourceQuote(editor, { source: () => props.quoteSource!, prepare: (quote, x, y, editable, editSource) => props.prepareQuote?.(quote, x, y, editable, editSource) ?? null })
    }
    stopTheme = observeDesktopMonacoTheme(monaco)
    stopUpdates = watch(() => [props.text, props.path, props.wrap] as const, ([text, path, wrap], previous) => {
      if (!editor || !model)
        return
      if (model.getValue() !== text)
        model.setValue(text)
      monaco.editor.setModelLanguage(model, languages[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'plaintext')
      editor.updateOptions({ wordWrap: wrap ? 'on' : 'off' })
      if (path !== previous?.[1])
        editor.setScrollTop(0)
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
  <div class="desktop-monaco-file">
    <div ref="container" class="desktop-monaco-file__editor" />
    <div v-if="failed" class="desktop-monaco-file__error">
      <slot name="error" />
    </div>
  </div>
</template>

<style scoped>
.desktop-monaco-file { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.desktop-monaco-file__editor { width: 100%; height: 100%; }
.desktop-monaco-file__error { position: absolute; inset: 0; display: grid; place-items: center; color: var(--buddy-text-muted); background: var(--buddy-surface-base); }
</style>
