import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { watch } from 'vue'
import { desktopThemeSnapshot } from '@/theme/desktopThemeState'

interface MonacoEnvironmentGlobal {
  MonacoEnvironment?: {
    getWorker: () => Worker
  }
}

let monacoPromise: Promise<typeof Monaco> | null = null
let stopTheme: (() => void) | null = null
let themeSubscribers = 0

export function loadDesktopMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    const global = globalThis as typeof globalThis & MonacoEnvironmentGlobal
    global.MonacoEnvironment = { getWorker: () => new EditorWorker() }
    const registrations = Promise.all([
      import('monaco-editor/features/codicon/register.js'),
      import('monaco-editor/languages/definitions/css/register.js'),
      import('monaco-editor/languages/definitions/html/register.js'),
      import('monaco-editor/languages/definitions/javascript/register.js'),
      import('monaco-editor/languages/definitions/markdown/register.js'),
      import('monaco-editor/languages/definitions/powershell/register.js'),
      import('monaco-editor/languages/definitions/python/register.js'),
      import('monaco-editor/languages/definitions/rust/register.js'),
      import('monaco-editor/languages/definitions/scss/register.js'),
      import('monaco-editor/languages/definitions/shell/register.js'),
      import('monaco-editor/languages/definitions/typescript/register.js'),
      import('monaco-editor/languages/definitions/xml/register.js'),
      import('monaco-editor/languages/definitions/yaml/register.js'),
    ])
    monacoPromise = Promise.all([
      import('monaco-editor/editor/editor.api.js'),
      registrations,
      import('monaco-editor/languages/definitions/powershell/powershell.js'),
      import('monaco-editor/languages/definitions/shell/shell.js'),
    ]).then(([monaco, , powershell, shell]) => {
      monaco.languages.setMonarchTokensProvider('powershell', powershell.language)
      monaco.languages.setMonarchTokensProvider('shell', shell.language)
      return monaco
    })
  }
  return monacoPromise
}

export function observeDesktopMonacoTheme(monaco: typeof Monaco): () => void {
  if (!themeSubscribers++) {
    stopTheme = watch(() => desktopThemeSnapshot.value.active, () => syncDesktopMonacoTheme(monaco), { immediate: true })
  }
  let disposed = false
  return () => {
    if (disposed)
      return
    disposed = true
    if (!--themeSubscribers) {
      stopTheme?.()
      stopTheme = null
    }
  }
}

function syncDesktopMonacoTheme(monaco: typeof Monaco): void {
  const { colors: c, descriptor } = desktopThemeSnapshot.value.active
  monaco.editor.defineTheme('buddy', {
    base: descriptor.appearance === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: ['comment', 'keyword', 'string', 'number', 'function', 'type', 'variable', 'operator'].map(token => ({ token, foreground: c[`syntax-${token}` as keyof typeof c].slice(1, 7) })),
    colors: {
      'focusBorder': c.focus,
      'editor.background': c.editor,
      'editor.foreground': c['editor-fg'],
      'editorLineNumber.foreground': c['editor-gutter'],
      'editor.lineHighlightBackground': c['editor-line'],
      'editorCursor.foreground': c['editor-cursor'],
      'editor.selectionBackground': c['text-selection'],
      'editor.inactiveSelectionBackground': c['text-selection-inactive'],
      'editor.selectionHighlightBackground': c['text-selection-match'],
      'diffEditor.insertedTextBackground': c['diff-added'],
      'diffEditor.removedTextBackground': c['diff-removed'],
      'list.hoverBackground': c.hover,
      'list.activeSelectionBackground': c.selected,
      'list.activeSelectionForeground': c['selected-fg'],
      'list.inactiveSelectionBackground': c['text-selection-inactive'],
      'list.inactiveSelectionForeground': c['selected-fg'],
      'list.focusBackground': c.selected,
      'list.focusForeground': c['selected-fg'],
    },
  })
  monaco.editor.setTheme('buddy')
}
