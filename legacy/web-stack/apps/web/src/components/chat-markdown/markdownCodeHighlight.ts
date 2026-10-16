import hljsCore from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import {
  resolveCodeBlockLanguage,
} from '@/components/tiptap-editor/extensions/code-block/languages'

// 使用隔离实例，避免和 Tiptap lowlight 注册表互相污染导致 Unknown language。
const hljs = hljsCore.newInstance()

const registeredLanguages = new Set<string>()

const staticLanguages = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  plaintext,
  python,
  shell,
  sql,
  typescript,
  xml,
  yaml,
}

for (const [name, language] of Object.entries(staticLanguages)) {
  hljs.registerLanguage(name, language)
  registeredLanguages.add(name)
}

export interface ChatCodeLanguage {
  label: string
  highlightLanguage: string
}

export function resolveChatCodeLanguage(info: string): ChatCodeLanguage {
  const firstWord = info.trim().split(/\s+/)[0] ?? ''

  if (!firstWord) {
    return {
      label: 'text',
      highlightLanguage: 'plaintext',
    }
  }

  const language = resolveCodeBlockLanguage(firstWord)

  return {
    label: language.label,
    highlightLanguage: language.highlightLanguage,
  }
}

export function highlightChatCode(code: string, language: string): string {
  if (!registeredLanguages.has(language)) {
    return escapeHtml(code)
  }

  try {
    return hljs.highlight(code, {
      language,
      ignoreIllegals: true,
    }).value
  }
  catch {
    return escapeHtml(code)
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}
