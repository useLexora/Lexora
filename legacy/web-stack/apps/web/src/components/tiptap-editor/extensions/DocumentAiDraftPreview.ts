import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT } from '@haohaoxue/lexora-contracts/agent'
import { Extension } from '@tiptap/core'
import { DOMSerializer, Fragment } from '@tiptap/pm/model'
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view'
import { translate } from '@/i18n'
import { isAddressableBodyBlock } from '../content/blockId'
import { mapTiptapRange } from '../utils/rangeMapping'

export interface DocumentAiDraftPreviewState {
  id: string
  intent: string
  previewMode?: 'block' | 'inline'
  from: number
  to: number
  candidateContent: JSONContent[]
}

export interface DocumentAiAnchorPreviewState {
  id: string
  from: number
  mode?: 'block' | 'inline'
  to: number
}

export interface DocumentAiDraftPreviewOptions {
  onAccept?: (candidateId: string) => void
  onReject?: (candidateId: string) => void
}

type DocumentAiDraftPreviewMeta
  = | {
    draft: DocumentAiDraftPreviewState
    type: 'set'
  }
  | {
    type: 'clear'
  }

type DocumentAiAnchorPreviewMeta
  = | {
    anchor: DocumentAiAnchorPreviewState
    type: 'set'
  }
  | {
    type: 'clear'
  }

const DOCUMENT_AI_DRAFT_DELETED_CLASS = 'tiptap-document-ai-draft-preview__deleted'
const DOCUMENT_AI_DRAFT_DELETED_BLOCK_CLASS = 'tiptap-document-ai-draft-preview__deleted-block'
const DOCUMENT_AI_DRAFT_EMPTY_ANCHOR_CLASS = 'tiptap-document-ai-draft-preview__empty-anchor'
const DOCUMENT_AI_DRAFT_INSERTED_CLASS = 'tiptap-document-ai-draft-preview__inserted'
const DOCUMENT_AI_DRAFT_LOCAL_EDITOR_CLASS = 'tiptap-document-ai-draft-preview__local-editor'
const DOCUMENT_AI_DRAFT_LOCAL_PROSEMIRROR_CLASS = 'tiptap-document-ai-draft-preview__prosemirror'
const DOCUMENT_AI_DRAFT_ACTIONS_CLASS = 'tiptap-document-ai-draft-preview__actions'
const DOCUMENT_AI_DRAFT_CHANGE_ATTRIBUTE = 'data-document-ai-draft-change'
const DOCUMENT_AI_ANCHOR_ACTIVE_CLASS = 'tiptap-document-ai-anchor-preview--active'
const DOCUMENT_AI_ANCHOR_SELECTION_CLASS = 'tiptap-document-ai-anchor-preview__selection'
const DOCUMENT_AI_ANCHOR_BLOCK_CLASS = 'tiptap-document-ai-anchor-preview__block'
const DOCUMENT_AI_ANCHOR_CURSOR_CLASS = 'tiptap-document-ai-anchor-preview__cursor'
const DOCUMENT_AI_ANCHOR_CURSOR_TEST_ID = 'document-ai-anchor-preview'
const documentAiDraftPreviewPluginKey = new PluginKey<DocumentAiDraftPreviewState | null>('documentAiDraftPreview')
const documentAiAnchorPreviewPluginKey = new PluginKey<DocumentAiAnchorPreviewState | null>('documentAiAnchorPreview')
type DocumentAiDraftRenderMode = 'block' | 'inline'
const documentAiDraftLocalEditorViews = new WeakMap<Node, EditorView>()

export const DocumentAiDraftPreview = Extension.create<DocumentAiDraftPreviewOptions>({
  name: 'documentAiDraftPreview',

  addOptions() {
    return {}
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DocumentAiDraftPreviewState | null>({
        key: documentAiDraftPreviewPluginKey,
        state: {
          init: () => null,
          apply(transaction, value) {
            const meta = transaction.getMeta(documentAiDraftPreviewPluginKey) as DocumentAiDraftPreviewMeta | undefined

            if (meta?.type === 'clear') {
              return null
            }

            if (meta?.type === 'set') {
              return normalizeDraft(meta.draft, transaction.doc)
            }

            if (!value || !transaction.docChanged) {
              return value
            }

            return normalizeDraft(mapDraft(transaction, value), transaction.doc)
          },
        },
        props: {
          decorations: (state) => {
            const draft = documentAiDraftPreviewPluginKey.getState(state)

            if (!draft) {
              return null
            }

            const renderMode = resolveDraftRenderMode(draft)
            const decorations = [
              Decoration.widget(
                resolveDocumentAiDraftWidgetPosition(state.doc, draft, renderMode),
                () => createDocumentAiDraftWidget({
                  draft,
                  renderMode,
                  schema: state.schema,
                }),
                {
                  key: `${draft.id}:content`,
                  destroy: destroyDocumentAiDraftWidget,
                  ignoreSelection: true,
                  side: 1,
                  stopEvent: () => true,
                },
              ),
            ]
            const hiddenAnchorRange = resolveDocumentAiDraftHiddenAnchorRange(state.doc, draft, renderMode)

            if (hiddenAnchorRange) {
              decorations.unshift(Decoration.node(hiddenAnchorRange.from, hiddenAnchorRange.to, {
                'class': DOCUMENT_AI_DRAFT_EMPTY_ANCHOR_CLASS,
                'data-document-ai-draft-anchor': 'empty',
              }))
            }

            if (draft.intent !== AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR && draft.to > draft.from) {
              decorations.unshift(draft.previewMode === 'block'
                ? Decoration.node(draft.from, draft.to, {
                    [DOCUMENT_AI_DRAFT_CHANGE_ATTRIBUTE]: 'deleted',
                    class: DOCUMENT_AI_DRAFT_DELETED_BLOCK_CLASS,
                  })
                : Decoration.inline(draft.from, draft.to, {
                    [DOCUMENT_AI_DRAFT_CHANGE_ATTRIBUTE]: 'deleted',
                    class: DOCUMENT_AI_DRAFT_DELETED_CLASS,
                  }))
            }

            return DecorationSet.create(state.doc, decorations)
          },
        },
        view: view => createDocumentAiDraftActionView(view, {
          onAccept: this.options.onAccept,
          onReject: this.options.onReject,
        }),
      }),
      new Plugin<DocumentAiAnchorPreviewState | null>({
        key: documentAiAnchorPreviewPluginKey,
        state: {
          init: () => null,
          apply(transaction, value) {
            const meta = transaction.getMeta(documentAiAnchorPreviewPluginKey) as DocumentAiAnchorPreviewMeta | undefined

            if (meta?.type === 'clear') {
              return null
            }

            if (meta?.type === 'set') {
              return normalizeAnchor(meta.anchor, transaction.doc)
            }

            if (!value || !transaction.docChanged) {
              return value
            }

            return normalizeAnchor(mapAnchor(transaction, value), transaction.doc)
          },
        },
        props: {
          decorations: (state) => {
            const anchor = documentAiAnchorPreviewPluginKey.getState(state)

            if (!anchor) {
              return null
            }

            if (anchor.to > anchor.from && anchor.mode === 'block') {
              return DecorationSet.create(state.doc, [
                Decoration.node(anchor.from, anchor.to, {
                  'class': DOCUMENT_AI_ANCHOR_BLOCK_CLASS,
                  'data-testid': DOCUMENT_AI_ANCHOR_CURSOR_TEST_ID,
                }),
              ])
            }

            if (anchor.to > anchor.from) {
              return DecorationSet.create(state.doc, [
                Decoration.inline(anchor.from, anchor.to, {
                  'class': DOCUMENT_AI_ANCHOR_SELECTION_CLASS,
                  'data-testid': DOCUMENT_AI_ANCHOR_CURSOR_TEST_ID,
                }),
              ])
            }

            return null
          },
        },
        view: view => createDocumentAiAnchorCursorView(view),
      }),
    ]
  },
})

export function setDocumentAiDraftPreview(editor: Editor, draft: DocumentAiDraftPreviewState) {
  if (!canDispatchEditorTransaction(editor)) {
    return
  }

  editor.view.dispatch(editor.state.tr
    .setMeta(documentAiDraftPreviewPluginKey, {
      draft,
      type: 'set',
    } satisfies DocumentAiDraftPreviewMeta)
    .setMeta('addToHistory', false))
}

export function clearDocumentAiDraftPreview(editor: Editor) {
  if (!canDispatchEditorTransaction(editor)) {
    return
  }

  editor.view.dispatch(editor.state.tr
    .setMeta(documentAiDraftPreviewPluginKey, {
      type: 'clear',
    } satisfies DocumentAiDraftPreviewMeta)
    .setMeta('addToHistory', false))
}

export function setDocumentAiAnchorPreview(editor: Editor, anchor: DocumentAiAnchorPreviewState) {
  if (!canDispatchEditorTransaction(editor)) {
    return
  }

  editor.view.dispatch(editor.state.tr
    .setMeta(documentAiAnchorPreviewPluginKey, {
      anchor,
      type: 'set',
    } satisfies DocumentAiAnchorPreviewMeta)
    .setMeta('addToHistory', false))
}

export function clearDocumentAiAnchorPreview(editor: Editor) {
  if (!canDispatchEditorTransaction(editor)) {
    return
  }

  editor.view.dispatch(editor.state.tr
    .setMeta(documentAiAnchorPreviewPluginKey, {
      type: 'clear',
    } satisfies DocumentAiAnchorPreviewMeta)
    .setMeta('addToHistory', false))
}

export function hasDocumentAiAnchorPreview(state: EditorState): boolean {
  return Boolean(documentAiAnchorPreviewPluginKey.getState(state))
}

function mapDraft(transaction: Transaction, draft: DocumentAiDraftPreviewState): DocumentAiDraftPreviewState {
  const mappedRange = mapTiptapRange(draft, transaction.mapping, {
    dropWhenDeletedAcross: false,
    allowCollapsed: true,
  })

  return {
    ...draft,
    from: mappedRange?.from ?? draft.from,
    to: mappedRange?.to ?? draft.to,
  }
}

function mapAnchor(transaction: Transaction, anchor: DocumentAiAnchorPreviewState): DocumentAiAnchorPreviewState | null {
  const mappedRange = mapTiptapRange(anchor, transaction.mapping, {
    allowCollapsed: true,
  })

  if (!mappedRange) {
    return null
  }

  return {
    ...anchor,
    from: mappedRange.from,
    to: mappedRange.to,
  }
}

function normalizeDraft(
  draft: DocumentAiDraftPreviewState,
  doc: ProseMirrorNode,
): DocumentAiDraftPreviewState | null {
  const documentSize = doc.content.size
  const from = clampPosition(draft.from, documentSize)
  const to = Math.max(from, clampPosition(draft.to, documentSize))

  if (!draft.candidateContent.length) {
    return null
  }

  return {
    ...draft,
    from,
    to,
  }
}

function normalizeAnchor(
  anchor: DocumentAiAnchorPreviewState | null,
  doc: ProseMirrorNode,
): DocumentAiAnchorPreviewState | null {
  if (!anchor) {
    return null
  }

  const documentSize = doc.content.size
  const from = clampPosition(anchor.from, documentSize)
  const to = Math.max(from, clampPosition(anchor.to, documentSize))

  return {
    ...anchor,
    from,
    to,
  }
}

function createDocumentAiDraftWidget(input: {
  draft: DocumentAiDraftPreviewState
  renderMode: DocumentAiDraftRenderMode
  schema: Schema
}) {
  const root = document.createElement(input.renderMode === 'inline' ? 'span' : 'section')
  root.className = `tiptap-document-ai-draft-preview tiptap-document-ai-draft-preview--${input.renderMode}`
  root.contentEditable = 'false'
  root.dataset.documentAiDraftId = input.draft.id
  root.setAttribute(DOCUMENT_AI_DRAFT_CHANGE_ATTRIBUTE, 'inserted')
  root.dataset.testid = 'document-ai-draft-preview'
  root.setAttribute('aria-label', translate('docs.aiCandidate.title'))

  const localEditor = input.renderMode === 'block'
    ? createLocalDraftEditor(input.schema, input.draft.candidateContent)
    : null

  if (localEditor) {
    root.append(localEditor.dom)
    documentAiDraftLocalEditorViews.set(root, localEditor.view)
  }
  else {
    const candidateContent = serializeCandidateContent(input.schema, input.draft.candidateContent, input.renderMode)
    markCandidateContent(candidateContent)
    root.append(candidateContent)
  }

  return root
}

function destroyDocumentAiDraftWidget(node: Node) {
  const localEditorView = documentAiDraftLocalEditorViews.get(node)

  if (!localEditorView) {
    return
  }

  localEditorView.destroy()
  documentAiDraftLocalEditorViews.delete(node)
}

function createDocumentAiDraftActionView(view: EditorView, options: DocumentAiDraftPreviewOptions) {
  let actions: HTMLElement | null = null
  let parent: HTMLElement | null = null
  let currentDraftId: string | null = null
  let currentView = view
  let positionUpdateFrame: number | null = null

  function update(nextView: EditorView) {
    currentView = nextView
    const draft = documentAiDraftPreviewPluginKey.getState(nextView.state)

    if (!draft) {
      remove()
      return
    }

    const nextParent = resolveEditorOverlayParent(nextView)

    if (!nextParent) {
      remove()
      return
    }

    if (!actions || currentDraftId !== draft.id) {
      actions?.remove()
      actions = createDocumentAiDraftActions({
        draft,
        onAccept: options.onAccept,
        onReject: options.onReject,
      })
      currentDraftId = draft.id
      parent = null
    }

    if (parent !== nextParent) {
      actions.remove()
      nextParent.append(actions)
      parent = nextParent
    }

    schedulePositionUpdate()
  }

  function schedulePositionUpdate() {
    if (positionUpdateFrame !== null) {
      return
    }

    positionUpdateFrame = globalThis.requestAnimationFrame(() => {
      positionUpdateFrame = null
      positionActions()
    })
  }

  function positionActions() {
    const draft = documentAiDraftPreviewPluginKey.getState(currentView.state)

    if (!actions || !parent || !draft) {
      return
    }

    const anchorRect = resolveDraftActionAnchorRect(currentView, draft)

    if (!anchorRect) {
      return
    }

    const parentRect = parent.getBoundingClientRect()
    const actionWidth = actions.offsetWidth
    const minX = parent.scrollLeft + 4
    const maxX = parent.scrollLeft + parent.clientWidth - actionWidth - 4
    const preferredX = anchorRect.right - parentRect.left + parent.scrollLeft + 8
    const x = Math.max(minX, Math.min(preferredX, maxX))
    const y = anchorRect.top - parentRect.top + parent.scrollTop

    actions.style.transform = `translate(${x}px, ${Math.max(parent.scrollTop, y)}px)`
  }

  function remove() {
    actions?.remove()
    actions = null
    parent = null
    currentDraftId = null
  }

  update(view)
  globalThis.addEventListener('resize', schedulePositionUpdate)
  document.addEventListener('scroll', schedulePositionUpdate, true)

  return {
    destroy() {
      globalThis.removeEventListener('resize', schedulePositionUpdate)
      document.removeEventListener('scroll', schedulePositionUpdate, true)
      if (positionUpdateFrame !== null) {
        globalThis.cancelAnimationFrame(positionUpdateFrame)
      }
      remove()
    },
    update,
  }
}

function createDocumentAiDraftActions(input: {
  draft: DocumentAiDraftPreviewState
  onAccept?: (candidateId: string) => void
  onReject?: (candidateId: string) => void
}) {
  const rejectButton = createDraftButton({
    className: 'tiptap-document-ai-draft-preview__button',
    label: translate('docs.aiCandidate.reject'),
    onClick: () => input.onReject?.(input.draft.id),
  })
  const acceptButton = createDraftButton({
    className: 'tiptap-document-ai-draft-preview__button is-primary',
    label: translate('docs.aiCandidate.accept'),
    onClick: () => input.onAccept?.(input.draft.id),
  })
  const actions = document.createElement('div')

  actions.className = DOCUMENT_AI_DRAFT_ACTIONS_CLASS
  actions.contentEditable = 'false'
  actions.dataset.documentAiDraftActions = input.draft.id
  actions.append(rejectButton, acceptButton)
  return actions
}

function resolveDraftActionAnchorRect(view: EditorView, draft: DocumentAiDraftPreviewState): DOMRect | null {
  const previewElement = view.dom.querySelector<HTMLElement>('[data-testid="document-ai-draft-preview"]')
  const firstPreviewBlock = previewElement?.querySelector<HTMLElement>(`.${DOCUMENT_AI_DRAFT_LOCAL_PROSEMIRROR_CLASS} > *`)

  if (firstPreviewBlock) {
    return firstPreviewBlock.getBoundingClientRect()
  }

  if (previewElement) {
    return previewElement.getBoundingClientRect()
  }

  const renderMode = resolveDraftRenderMode(draft)
  const position = resolveDocumentAiDraftWidgetPosition(view.state.doc, draft, renderMode)
  const coords = view.coordsAtPos(position)

  return {
    bottom: coords.bottom,
    height: coords.bottom - coords.top,
    left: coords.left,
    right: coords.right,
    toJSON: () => ({}),
    top: coords.top,
    width: coords.right - coords.left,
    x: coords.left,
    y: coords.top,
  }
}

function createDocumentAiAnchorCursorView(view: EditorView) {
  let cursor: HTMLElement | null = null
  let parent: HTMLElement | null = null
  let currentView = view
  let positionUpdateFrame: number | null = null

  function update(nextView: EditorView) {
    currentView = nextView
    syncNativeSelectionSuppression()

    const anchor = documentAiAnchorPreviewPluginKey.getState(nextView.state)

    if (!anchor || anchor.to > anchor.from) {
      remove()
      return
    }

    const nextParent = resolveAnchorCursorParent(nextView)

    if (!nextParent) {
      remove()
      return
    }

    if (!cursor) {
      cursor = createDocumentAiAnchorCursorElement()
    }

    if (parent !== nextParent) {
      cursor.remove()
      nextParent.append(cursor)
      parent = nextParent
    }

    positionAnchorCursor({
      cursor,
      parent: nextParent,
      view: nextView,
      position: anchor.from,
    })
  }

  function schedulePositionUpdate() {
    if (positionUpdateFrame !== null) {
      return
    }

    positionUpdateFrame = globalThis.requestAnimationFrame(() => {
      positionUpdateFrame = null
      update(currentView)
    })
  }

  function remove() {
    cursor?.remove()
    cursor = null
    parent = null
  }

  function syncNativeSelectionSuppression() {
    const anchor = documentAiAnchorPreviewPluginKey.getState(currentView.state)
    currentView.dom.classList.toggle(DOCUMENT_AI_ANCHOR_ACTIVE_CLASS, Boolean(anchor && !currentView.hasFocus()))
  }

  function handleFocusChange() {
    globalThis.setTimeout(syncNativeSelectionSuppression)
  }

  update(view)
  view.dom.addEventListener('focusin', handleFocusChange)
  view.dom.addEventListener('focusout', handleFocusChange)
  globalThis.addEventListener('resize', schedulePositionUpdate)
  document.addEventListener('scroll', schedulePositionUpdate, true)

  return {
    destroy() {
      view.dom.removeEventListener('focusin', handleFocusChange)
      view.dom.removeEventListener('focusout', handleFocusChange)
      globalThis.removeEventListener('resize', schedulePositionUpdate)
      document.removeEventListener('scroll', schedulePositionUpdate, true)
      if (positionUpdateFrame !== null) {
        globalThis.cancelAnimationFrame(positionUpdateFrame)
      }
      currentView.dom.classList.remove(DOCUMENT_AI_ANCHOR_ACTIVE_CLASS)
      remove()
    },
    update,
  }
}

function createDocumentAiAnchorCursorElement() {
  const cursor = document.createElement('i')
  cursor.className = DOCUMENT_AI_ANCHOR_CURSOR_CLASS
  cursor.contentEditable = 'false'
  cursor.dataset.testid = DOCUMENT_AI_ANCHOR_CURSOR_TEST_ID
  cursor.setAttribute('aria-hidden', 'true')
  return cursor
}

function resolveEditorOverlayParent(view: EditorView) {
  return view.dom.closest<HTMLElement>('.tiptap-editor') ?? view.dom.parentElement
}

function resolveAnchorCursorParent(view: EditorView) {
  return resolveEditorOverlayParent(view)
}

function positionAnchorCursor(input: {
  cursor: HTMLElement
  parent: HTMLElement
  position: number
  view: EditorView
}) {
  const position = clampPosition(input.position, input.view.state.doc.content.size)
  const coords = input.view.coordsAtPos(position)
  const parentRect = input.parent.getBoundingClientRect()
  const height = Math.max(16, coords.bottom - coords.top)

  input.cursor.style.transform = `translate(${coords.left - parentRect.left + input.parent.scrollLeft}px, ${coords.top - parentRect.top + input.parent.scrollTop}px)`
  input.cursor.style.height = `${height}px`
}

function createDraftButton(input: {
  className: string
  label: string
  onClick: () => void
}) {
  const button = document.createElement('button')
  button.className = input.className
  button.type = 'button'
  button.textContent = input.label
  button.setAttribute('aria-label', input.label)
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    input.onClick()
  })
  return button
}

function serializeCandidateContent(schema: Schema, content: JSONContent[], renderMode: DocumentAiDraftRenderMode) {
  const fragment = document.createDocumentFragment()
  const nodes = createCandidateNodes(schema, content)

  if (!nodes.length) {
    return fragment
  }

  if (renderMode === 'inline' && nodes.length === 1) {
    fragment.append(DOMSerializer
      .fromSchema(schema)
      .serializeFragment(nodes[0].content, { document }))
    return fragment
  }

  fragment.append(DOMSerializer
    .fromSchema(schema)
    .serializeFragment(Fragment.fromArray(nodes), { document }))
  return fragment
}

function createLocalDraftEditor(schema: Schema, content: JSONContent[]) {
  const nodes = createCandidateNodes(schema, content)
  const doc = schema.topNodeType.createAndFill(null, Fragment.fromArray(nodes))

  if (!doc) {
    return null
  }

  const dom = document.createElement('div')
  dom.className = DOCUMENT_AI_DRAFT_LOCAL_EDITOR_CLASS
  dom.dataset.documentAiDraftLocalEditor = 'true'

  const view = new EditorView(dom, {
    state: EditorState.create({
      doc,
      schema,
    }),
    editable: () => false,
    attributes: {
      class: `tiptap-editor__prosemirror ${DOCUMENT_AI_DRAFT_LOCAL_PROSEMIRROR_CLASS}`,
    },
  })

  return {
    dom,
    view,
  }
}

function createCandidateNodes(schema: Schema, content: JSONContent[]) {
  return content.flatMap((node) => {
    try {
      return [schema.nodeFromJSON(node)]
    }
    catch {
      return []
    }
  })
}

function markCandidateContent(fragment: DocumentFragment) {
  for (const node of Array.from(fragment.childNodes)) {
    if (node instanceof HTMLElement) {
      node.classList.add(DOCUMENT_AI_DRAFT_INSERTED_CLASS)
    }
  }
}

function resolveDraftRenderMode(draft: DocumentAiDraftPreviewState): DocumentAiDraftRenderMode {
  return draft.previewMode === 'inline' && canRenderInlineCandidateContent(draft.candidateContent)
    ? 'inline'
    : 'block'
}

function canRenderInlineCandidateContent(content: JSONContent[]) {
  return content.length === 1 && content[0]?.type === 'paragraph'
}

export function resolveDocumentAiDraftWidgetPosition(
  doc: ProseMirrorNode,
  draft: DocumentAiDraftPreviewState,
  renderMode: DocumentAiDraftRenderMode,
) {
  const position = clampPosition(draft.to, doc.content.size)

  if (renderMode === 'inline') {
    return position
  }

  const hiddenAnchorRange = resolveDocumentAiDraftHiddenAnchorRange(doc, draft, renderMode)

  if (hiddenAnchorRange) {
    return hiddenAnchorRange.from
  }

  return resolveAddressableBlockEndPosition(doc, position)
}

export function resolveDocumentAiDraftHiddenAnchorRange(
  doc: ProseMirrorNode,
  draft: DocumentAiDraftPreviewState,
  renderMode: DocumentAiDraftRenderMode,
) {
  if (
    renderMode !== 'block'
    || draft.intent !== AGENT_DOCUMENT_ASSISTANT_EDIT_INTENT.CONTINUE_AT_ANCHOR
    || draft.to !== draft.from
  ) {
    return null
  }

  return resolveCollapsedEmptyAddressableBlockRange(doc, draft.to)
}

function resolveCollapsedEmptyAddressableBlockRange(doc: ProseMirrorNode, position: number) {
  const resolvedPosition = doc.resolve(clampPosition(position, doc.content.size))

  for (let depth = resolvedPosition.depth; depth > 0; depth -= 1) {
    const node = resolvedPosition.node(depth)
    const parent = resolvedPosition.node(depth - 1)

    if (!isAddressableBodyBlock(node, parent)) {
      continue
    }

    if (!node.isTextblock || node.content.size > 0) {
      return null
    }

    return {
      from: resolvedPosition.before(depth),
      to: resolvedPosition.after(depth),
    }
  }

  return null
}

function resolveAddressableBlockEndPosition(doc: ProseMirrorNode, position: number) {
  const resolvedPosition = doc.resolve(position)

  for (let depth = resolvedPosition.depth; depth > 0; depth -= 1) {
    const node = resolvedPosition.node(depth)
    const parent = resolvedPosition.node(depth - 1)

    if (isAddressableBodyBlock(node, parent)) {
      return resolvedPosition.after(depth)
    }
  }

  return position
}

function canDispatchEditorTransaction(editor: Editor): boolean {
  return !editor.isDestroyed
    && typeof editor.view?.dispatch === 'function'
    && typeof editor.state?.tr?.setMeta === 'function'
}

function clampPosition(position: number, documentSize: number) {
  return Math.max(0, Math.min(position, documentSize))
}
