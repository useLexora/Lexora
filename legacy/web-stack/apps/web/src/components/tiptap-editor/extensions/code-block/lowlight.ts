import type { Editor } from '@tiptap/core'
import type { LanguageFn } from 'highlight.js'
import { createLowlight } from 'lowlight'

export const codeBlockLowlight = createLowlight()

type LanguageLoader = () => Promise<{ default: LanguageFn }>

export const CODE_BLOCK_LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  latex: () => import('highlight.js/lib/languages/latex'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  php: () => import('highlight.js/lib/languages/php'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scss: () => import('highlight.js/lib/languages/scss'),
  shell: () => import('highlight.js/lib/languages/shell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
}

export const CODE_BLOCK_LANGUAGE_ALIASES: Record<string, readonly string[]> = {
  bash: ['sh'],
  csharp: ['cs'],
  cpp: ['c++'],
  fsharp: ['fs', 'f#'],
  ini: ['toml'],
  javascript: ['js', 'jsx'],
  markdown: ['md'],
  plaintext: ['text', 'plain', 'regex', 'regexp'],
  typescript: ['ts', 'tsx'],
  xml: ['html', 'vue'],
  yaml: ['yml'],
}

const pendingLoads = new Map<string, Promise<boolean>>()

export async function ensureCodeBlockLanguage(name: string): Promise<boolean> {
  const loader = CODE_BLOCK_LANGUAGE_LOADERS[name]

  if (!loader || codeBlockLowlight.registered(name)) {
    return false
  }

  const existing = pendingLoads.get(name)

  if (existing) {
    return existing
  }

  const loadPromise = (async () => {
    const mod = await loader()
    codeBlockLowlight.register(name, mod.default)

    const aliases = CODE_BLOCK_LANGUAGE_ALIASES[name]

    if (aliases?.length) {
      codeBlockLowlight.registerAlias(name, [...aliases])
    }

    return true
  })()
    .finally(() => {
      pendingLoads.delete(name)
    })

  pendingLoads.set(name, loadPromise)

  return loadPromise
}

export function refreshCodeBlocksByLanguage(editor: Editor, language: string) {
  if (editor.isDestroyed) {
    return
  }

  const view = editor.view
  const state = view.state
  const tr = state.tr
  let changed = false

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') {
      return true
    }

    if (node.attrs.language === language || (!node.attrs.language && language === 'javascript')) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs })
      changed = true
    }

    return false
  })

  if (!changed) {
    return
  }

  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

export async function ensureCodeBlockLanguageAndRefresh(editor: Editor, name: string) {
  const loaded = await ensureCodeBlockLanguage(name)

  if (loaded) {
    refreshCodeBlocksByLanguage(editor, name)
  }
}
