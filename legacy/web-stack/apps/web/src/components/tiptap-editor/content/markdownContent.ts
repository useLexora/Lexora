import type { Editor, JSONContent } from '@tiptap/core'
import type MarkdownIt from 'markdown-it'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import DOMPurify from 'dompurify'
import MarkdownItConstructor from 'markdown-it'
import { normalizeCodeBlockLanguage } from '../extensions/code-block/languages'

const SAFE_LINK_PROTOCOL_PATTERN = /^(?:https?:|mailto:|\/|#)/i
const MARKDOWN_BLOCK_SYNTAX_PATTERNS = [
  /^ {0,3}#{1,6}\s+\S/m,
  /^ {0,3}(?:[-+*]\s+\S|\d+[.)]\s+\S)/m,
  /^ {0,3}[-+*]\s+\[[ x]\]\s+\S/im,
  /^ {0,3}>\s+\S/m,
  /^ {0,3}(?:---|\*\*\*|___)\s*$/m,
  /^ {0,3}\|.+\|\s*\n {0,3}\|[-:\s|]+\|/m,
  /^ {0,3}(?:```|~~~)/m,
]
let editorMarkdownRenderer: MarkdownIt | null = null

export function createMarkdownInsertContent(editor: Editor, markdownText: string): JSONContent[] {
  const html = renderEditorMarkdown(markdownText)
  const container = document.createElement('div')
  container.innerHTML = html
  normalizeTaskListHtml(container)

  const doc = ProseMirrorDOMParser
    .fromSchema(editor.schema)
    .parse(container)
    .toJSON() as { content?: JSONContent[] }

  return normalizeParsedMarkdownContent(doc.content ?? [])
}

export function hasMarkdownInsertBlockSyntax(text: string): boolean {
  return MARKDOWN_BLOCK_SYNTAX_PATTERNS.some(pattern => pattern.test(text))
}

function renderEditorMarkdown(markdownText: string): string {
  const markdown = getEditorMarkdownRenderer()

  return DOMPurify.sanitize(markdown.render(markdownText), {
    ADD_ATTR: ['checked', 'class', 'data-checked', 'data-type', 'href', 'rel', 'start', 'target'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'img'],
  })
}

function getEditorMarkdownRenderer(): MarkdownIt {
  if (!editorMarkdownRenderer) {
    editorMarkdownRenderer = createEditorMarkdownRenderer()
  }

  return editorMarkdownRenderer
}

function createEditorMarkdownRenderer(): MarkdownIt {
  const markdown = new MarkdownItConstructor({
    html: false,
    linkify: true,
    breaks: false,
  })

  markdown.validateLink = isSafeMarkdownLink
  markdown.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    const language = normalizeCodeBlockLanguage(token?.info ?? '')
    const content = (token?.content ?? '').replace(/\n$/, '')

    return [
      '<pre><code',
      language ? ` class="language-${escapeHtml(language)}"` : '',
      '>',
      escapeHtml(content),
      '</code></pre>\n',
    ].join('')
  }

  return markdown
}

function normalizeTaskListHtml(container: HTMLElement) {
  for (const list of Array.from(container.querySelectorAll('ul'))) {
    const taskItems = Array.from(list.children).filter((child): child is HTMLLIElement =>
      child instanceof HTMLLIElement && isTaskListItem(child),
    )

    if (!taskItems.length || taskItems.length !== list.children.length) {
      continue
    }

    list.setAttribute('data-type', 'taskList')

    for (const item of taskItems) {
      const checked = readTaskListItemChecked(item)
      removeTaskListItemMarker(item)
      item.setAttribute('data-type', 'taskItem')
      item.setAttribute('data-checked', checked ? 'true' : 'false')
    }
  }
}

function isTaskListItem(item: HTMLLIElement) {
  return /^\s*\[[ x]\]\s+/i.test(item.textContent ?? '')
}

function readTaskListItemChecked(item: HTMLLIElement) {
  return /^\s*\[x\]/i.test(item.textContent ?? '')
}

function removeTaskListItemMarker(item: HTMLLIElement) {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
  const textNode = walker.nextNode()

  if (!textNode) {
    return
  }

  textNode.textContent = (textNode.textContent ?? '').replace(/^\s*\[[ x]\]\s+/i, '')
}

function isSafeMarkdownLink(url: string): boolean {
  const normalized = url.trim()

  return Boolean(normalized && SAFE_LINK_PROTOCOL_PATTERN.test(normalized))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function normalizeParsedMarkdownContent(content: JSONContent[]): JSONContent[] {
  return content.map(normalizeParsedMarkdownNode)
}

function normalizeParsedMarkdownNode(node: JSONContent): JSONContent {
  const nextNode: JSONContent = { ...node }

  if (nextNode.attrs) {
    const attrs = Object.fromEntries(
      Object.entries(nextNode.attrs).filter(([, value]) => value !== null && value !== undefined),
    )

    if (Object.keys(attrs).length) {
      nextNode.attrs = attrs
    }
    else {
      delete nextNode.attrs
    }
  }

  if (nextNode.content) {
    nextNode.content = normalizeParsedMarkdownContent(nextNode.content)
  }

  if (nextNode.marks) {
    nextNode.marks = nextNode.marks.map((mark) => {
      if (!mark.attrs) {
        return mark
      }

      const attrs = Object.fromEntries(
        Object.entries(mark.attrs).filter(([, value]) => value !== null && value !== undefined),
      )

      return Object.keys(attrs).length
        ? { ...mark, attrs }
        : { type: mark.type }
    })
  }

  return nextNode
}
