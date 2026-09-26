import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { buddyPromptDirectiveSchema, buddyPromptDirectiveToText, buddyResourceIdSchema } from '@buddy-shared/conversation/buddyUserContent'
import { Extension, Node } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { DOMSerializer, Fragment, Slice } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import { watchEffect } from 'vue'
import {
  CHAT_PROMPT_DIRECTIVE_NODE_NAME,
  CHAT_RESOURCE_REFERENCE_NODE_NAME,
  userContentToChatComposerDocument,
} from '../model/chatComposerDocument'

const RESOURCE_EDIT_META = 'buddy-composer-resource-edit'
const CLIPBOARD_TYPE = 'application/x-lexora-composer'
let copiedSlice: { draftId: string, editorSessionId: string, slice: Slice, token: string } | null = null

export const ChatComposerResourceClipboard = Extension.create<{
  draftId: () => string
  rejectedIds: () => ReadonlySet<string>
}>({
  name: 'chatComposerResourceClipboard',
  addProseMirrorPlugins() {
    const options = this.options
    const editorSessionId = crypto.randomUUID()
    return [new Plugin({
      appendTransaction(_transactions, _oldState, state) {
        const rejected = options.rejectedIds()
        const transaction = state.tr
        const ranges: { from: number, to: number }[] = []
        state.doc.descendants((node, pos) => {
          if (node.type.name === CHAT_RESOURCE_REFERENCE_NODE_NAME && rejected.has(node.attrs.resourceId))
            ranges.push({ from: pos, to: pos + node.nodeSize })
        })
        for (const range of ranges.reverse())
          transaction.delete(range.from, range.to)
        const panel: string[] = state.doc.attrs.panelResourceIds
        if (panel.some(id => rejected.has(id)))
          transaction.setDocAttribute('panelResourceIds', panel.filter(id => !rejected.has(id)))
        return transaction.docChanged ? transaction.setMeta('addToHistory', false) : null
      },
      props: {
        handleDOMEvents: {
          copy: (view, event) => copy(view, event, false),
          cut: (view, event) => copy(view, event, true),
        },
        handlePaste(view, event) {
          const token = event.clipboardData?.getData(CLIPBOARD_TYPE)
          if (!copiedSlice || copiedSlice.token !== token || copiedSlice.draftId !== options.draftId() || copiedSlice.editorSessionId !== editorSessionId)
            return false
          event.preventDefault()
          view.dispatch(closeHistory(view.state.tr.replaceSelection(copiedSlice.slice)).setMeta(RESOURCE_EDIT_META, true))
          return true
        },
      },
    })]

    function copy(view: EditorView, event: ClipboardEvent, cut: boolean) {
      if (!event.clipboardData || view.state.selection.empty || (cut && !view.editable))
        return false
      const slice = view.state.selection.content()
      const token = crypto.randomUUID()
      copiedSlice = { draftId: options.draftId(), editorSessionId, slice, token }
      const holder = document.createElement('div')
      holder.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content))
      event.clipboardData.setData(CLIPBOARD_TYPE, token)
      event.clipboardData.setData('text/html', holder.innerHTML)
      event.clipboardData.setData('text/plain', slice.content.textBetween(0, slice.content.size, '\n', node => DOMSerializer.fromSchema(view.state.schema).serializeNode(node).textContent ?? ''))
      event.preventDefault()
      if (cut)
        view.dispatch(closeHistory(view.state.tr.deleteSelection()).setMeta(RESOURCE_EDIT_META, true))
      return true
    }
  },
})

export const ChatComposerDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'paragraph+',

  addAttributes() {
    return { panelResourceIds: { default: [], rendered: false }, quotes: { default: null, rendered: false } }
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction: (transactions, _oldState, newState) => transactions.some(
        transaction => transaction.getMeta(RESOURCE_EDIT_META),
      )
        ? closeHistory(newState.tr)
        : null,
    })]
  },
})

export const ChatComposerResourceReference = Node.create<{
  resourcePresentation: (resourceId: string) => {
    iconName: string
    iconUrl: string
    isImage?: boolean
    label: string
    text: string
  }
}>({
  name: CHAT_RESOURCE_REFERENCE_NODE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      resourcePresentation: () => ({
        iconName: 'file',
        iconUrl: '',
        label: 'file',
        text: '@file',
      }),
    }
  },

  addAttributes() {
    return { resourceId: { default: null, rendered: false } }
  },

  renderHTML({ node }) {
    return [
      'span',
      { 'class': 'chat-prompt-token-node', 'contenteditable': 'false', 'data-type': 'chat-resource-reference' },
      this.options.resourcePresentation(node.attrs.resourceId).text,
    ]
  },

  renderText({ node }) {
    return this.options.resourcePresentation(node.attrs.resourceId).text
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      const icon = document.createElement('img')
      const label = document.createElement('span')
      dom.className = 'chat-prompt-token-node'
      dom.contentEditable = 'false'
      dom.dataset.type = 'chat-resource-reference'
      dom.dataset.resourceId = node.attrs.resourceId
      icon.alt = ''
      icon.className = 'chat-resource-reference__icon'
      icon.draggable = false
      label.className = 'chat-resource-reference__label'
      dom.append(icon, label)
      const stop = watchEffect(() => {
        const presentation = this.options.resourcePresentation(node.attrs.resourceId)
        dom.classList.toggle('is-image', Boolean(presentation.isImage))
        dom.setAttribute('role', presentation.isImage ? 'link' : 'button')
        icon.dataset.fileIcon = presentation.iconName
        icon.hidden = !presentation.iconUrl
        if (presentation.iconUrl)
          icon.src = presentation.iconUrl
        else
          icon.removeAttribute('src')
        label.textContent = presentation.label
      })
      return { dom, destroy: stop }
    }
  },

})

export const ChatComposerPromptDirective = Node.create({
  name: CHAT_PROMPT_DIRECTIVE_NODE_NAME,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      commandMode: { default: null, rendered: false },
      commandId: { default: null, rendered: false },
      directive: { default: 'skill', rendered: false },
      skill: { default: null, rendered: false },
      value: { default: '', rendered: false },
    }
  },

  renderHTML({ node }) {
    return [
      'span',
      { class: 'chat-prompt-token-node', contenteditable: 'false' },
      directiveLabel(node.attrs),
    ]
  },

  renderText({ node }) {
    return directiveLabel(node.attrs)
  },
})

export function insertChatComposerResources(
  editor: Editor,
  resourceIds: readonly string[],
  placement: 'inline' | 'panel' | 'both',
): boolean {
  if (!resourceIds.length || editor.isDestroyed || !editor.isEditable)
    return false
  const ids = resourceIds.map(id => buddyResourceIdSchema.parse(id))
  const transaction = editor.state.tr

  if (placement !== 'inline') {
    const current: string[] = transaction.doc.attrs.panelResourceIds
    const next = [...new Set([...current, ...ids])]
    if (next.length !== current.length)
      transaction.setDocAttribute('panelResourceIds', next)
  }
  if (placement !== 'panel') {
    const nodeType = editor.schema.nodes[CHAT_RESOURCE_REFERENCE_NODE_NAME]!
    const fragment = Fragment.fromArray(ids.map(resourceId => nodeType.create({ resourceId })))
    transaction.replaceSelection(new Slice(fragment, 0, 0))
  }

  return dispatchResourceEdit(editor, transaction)
}

export async function insertResolvedChatComposerResource(
  editor: Editor,
  range: { from: number, to: number },
  resolveResource: () => Promise<string | null>,
): Promise<boolean> {
  const original = editor.state.doc.slice(range.from, range.to)
  let currentRange = range
  let valid = true
  const track = ({ transaction }: { transaction: Transaction }) => {
    if (!valid || !transaction.docChanged)
      return
    currentRange = {
      from: transaction.mapping.map(currentRange.from, 1),
      to: transaction.mapping.map(currentRange.to, -1),
    }
    valid = currentRange.from < currentRange.to
      && transaction.doc.slice(currentRange.from, currentRange.to).eq(original)
  }
  editor.on('transaction', track)
  try {
    const resourceId = await resolveResource()
    if (!resourceId || !valid || editor.isDestroyed || !editor.isEditable)
      return false
    const transaction = closeHistory(editor.state.tr)
      .replaceWith(currentRange.from, currentRange.to, [
        editor.schema.nodes[CHAT_RESOURCE_REFERENCE_NODE_NAME]!.create({ resourceId }),
        editor.schema.text(' '),
      ])
      .setMeta(RESOURCE_EDIT_META, true)
    editor.view.dispatch(transaction)
    return true
  }
  finally {
    editor.off('transaction', track)
  }
}

export function removeChatComposerPanelResource(editor: Editor, resourceId: string): boolean {
  if (editor.isDestroyed || !editor.isEditable)
    return false
  const current: string[] = editor.state.doc.attrs.panelResourceIds
  if (!current.includes(resourceId))
    return false
  return dispatchResourceEdit(editor, editor.state.tr.setDocAttribute(
    'panelResourceIds',
    current.filter(id => id !== resourceId),
  ))
}

export function removeChatComposerResource(editor: Editor, resourceId: string): boolean {
  if (editor.isDestroyed || !editor.isEditable)
    return false
  const transaction = editor.state.tr
  const ranges: Array<{ from: number, to: number }> = []
  transaction.doc.descendants((node, position) => {
    if (node.type.name === CHAT_RESOURCE_REFERENCE_NODE_NAME && node.attrs.resourceId === resourceId)
      ranges.push({ from: position, to: position + node.nodeSize })
  })
  for (const range of ranges.toReversed())
    transaction.delete(range.from, range.to)
  const current: string[] = transaction.doc.attrs.panelResourceIds
  if (current.includes(resourceId)) {
    transaction.setDocAttribute(
      'panelResourceIds',
      current.filter(id => id !== resourceId),
    )
  }
  return dispatchResourceEdit(editor, transaction)
}

export function setChatComposerPanelResources(editor: Editor, resourceIds: readonly string[]): boolean {
  const current: string[] = editor.state.doc.attrs.panelResourceIds
  if (current.length === resourceIds.length && current.every((id, index) => id === resourceIds[index]))
    return false
  return dispatchResourceEdit(editor, editor.state.tr.setDocAttribute('panelResourceIds', [...resourceIds]))
}

export function replaceChatComposerDocument(editor: Editor, content: BuddyUserContentV1): boolean {
  if (editor.isDestroyed || !editor.isEditable)
    return false
  const document = editor.schema.nodeFromJSON(userContentToChatComposerDocument(content))
  return dispatchResourceEdit(editor, editor.state.tr
    .replaceWith(0, editor.state.doc.content.size, document.content)
    .setDocAttribute('panelResourceIds', document.attrs.panelResourceIds)
    .setDocAttribute('quotes', document.attrs.quotes))
}

function dispatchResourceEdit(editor: Editor, transaction: Transaction): boolean {
  if (!transaction.docChanged)
    return false
  editor.view.dispatch(closeHistory(transaction).setMeta(RESOURCE_EDIT_META, true))
  return true
}

export function moveChatComposerResourceSelection(editor: Editor, direction: -1 | 1): boolean {
  const { selection } = editor.state
  if (selection instanceof NodeSelection && selection.node.type.name === CHAT_RESOURCE_REFERENCE_NODE_NAME) {
    const position = direction < 0 ? selection.from : selection.to
    const nextSelection = TextSelection.near(editor.state.doc.resolve(position), direction)
    editor.view.dispatch(editor.state.tr.setSelection(nextSelection).scrollIntoView())
    return true
  }
  if (!selection.empty)
    return false

  const resourcePosition = findAdjacentChatComposerResource(editor, direction)
  if (resourcePosition === null)
    return false
  editor.view.dispatch(editor.state.tr
    .setSelection(NodeSelection.create(editor.state.doc, resourcePosition))
    .scrollIntoView())
  return true
}

function findAdjacentChatComposerResource(editor: Editor, direction: -1 | 1): number | null {
  const { $from } = editor.state.selection
  const node = direction < 0 ? $from.nodeBefore : $from.nodeAfter
  const position = direction < 0
    ? $from.pos - (node?.nodeSize ?? 0)
    : $from.pos
  if (node?.type.name === CHAT_RESOURCE_REFERENCE_NODE_NAME)
    return position
  if (!node?.isText || !/^\s+$/u.test(node.text ?? ''))
    return null

  const neighborPosition = direction < 0
    ? position
    : position + node.nodeSize
  const neighbor = direction < 0
    ? editor.state.doc.resolve(neighborPosition).nodeBefore
    : editor.state.doc.resolve(neighborPosition).nodeAfter
  if (neighbor?.type.name !== CHAT_RESOURCE_REFERENCE_NODE_NAME)
    return null
  return direction < 0
    ? neighborPosition - neighbor.nodeSize
    : neighborPosition
}

function directiveLabel(attrs: Record<string, unknown>): string {
  const directive = buddyPromptDirectiveSchema.parse({
    ...(attrs.directive === 'skill' ? {} : { commandMode: attrs.commandMode }),
    directive: attrs.directive,
    type: 'prompt_directive',
    value: attrs.value,
  })
  return buddyPromptDirectiveToText(directive)
}
