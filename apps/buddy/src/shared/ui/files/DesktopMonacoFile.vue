<script setup lang="ts">
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { shallowRef, useTemplateRef, watch } from 'vue'
import { loadDesktopMonaco, observeDesktopMonacoTheme } from '@/shared/ui/monaco/desktopMonaco'

const props = defineProps<{ text: string, path: string, wrap: boolean }>()
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
  <div class="desktop-monaco-file relative w-full h-full min-w-0 min-h-0">
    <div ref="container" class="w-full h-full" />
    <div v-if="failed" class="absolute inset-0 grid place-items-center text-muted bg-surface">
      <slot name="error" />
    </div>
  </div>
</template>
