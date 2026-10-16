import type { Editor, Range } from '@tiptap/core'
import type { ComponentPublicInstance, ComputedRef, ShallowRef } from 'vue'
import type { LinkPanelController } from '../shared/useLinkPanel'
import { getMarkRange } from '@tiptap/core'
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'

const LINK_PREVIEW_FALLBACK_WIDTH = 288
const LINK_PREVIEW_GAP = 8
const LINK_PREVIEW_SCREEN_GAP = 12
const LINK_PREVIEW_OPEN_DELAY = 520
const LINK_PREVIEW_CLOSE_DELAY = 120

interface LinkPreviewTarget {
  element: HTMLAnchorElement
  href: string
  range: Range
  text: string
}

type LinkPreviewRefTarget = Element | ComponentPublicInstance | null

export interface LinkPreviewController {
  isOpen: ShallowRef<boolean>
  href: ShallowRef<string>
  text: ShallowRef<string>
  style: ComputedRef<Record<string, string>>
  assignPreviewRef: (element: LinkPreviewRefTarget) => void
  close: () => void
  edit: () => void
  handlePreviewMouseEnter: () => void
  handlePreviewMouseLeave: () => void
}

export function useLinkPreview(
  editor: Editor,
  linkPanel: LinkPanelController,
): LinkPreviewController {
  const isOpen = shallowRef(false)
  const href = shallowRef('')
  const text = shallowRef('')
  const targetRange = shallowRef<Range | null>(null)
  const targetElement = shallowRef<HTMLAnchorElement | null>(null)
  const previewElement = shallowRef<HTMLElement | null>(null)
  const position = shallowRef({
    left: 0,
    top: 0,
  })
  let openTimer: ReturnType<typeof setTimeout> | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  const style = computed(() => ({
    left: `${position.value.left}px`,
    top: `${position.value.top}px`,
  }))

  editor.view.dom.addEventListener('mouseover', handleEditorMouseOver)
  editor.view.dom.addEventListener('mouseout', handleEditorMouseOut)
  window.addEventListener('resize', updateVisiblePosition)
  window.addEventListener('scroll', updateVisiblePosition, true)

  watch(
    () => linkPanel.isOpen.value,
    (isLinkPanelOpen) => {
      if (isLinkPanelOpen) {
        close()
      }
    },
  )

  onBeforeUnmount(() => {
    editor.view.dom.removeEventListener('mouseover', handleEditorMouseOver)
    editor.view.dom.removeEventListener('mouseout', handleEditorMouseOut)
    window.removeEventListener('resize', updateVisiblePosition)
    window.removeEventListener('scroll', updateVisiblePosition, true)
    clearTimers()
  })

  function handleEditorMouseOver(event: MouseEvent) {
    if (linkPanel.isOpen.value) {
      close()
      return
    }

    const linkElement = getEventLinkElement(event)

    if (!linkElement) {
      return
    }

    cancelClose()

    if (linkElement === targetElement.value && (isOpen.value || openTimer)) {
      return
    }

    const target = resolveLinkPreviewTarget(linkElement)

    if (!target) {
      return
    }

    targetElement.value = target.element
    targetRange.value = target.range
    href.value = target.href
    text.value = target.text
    updatePosition(target.element)
    scheduleOpen()
  }

  function handleEditorMouseOut(event: MouseEvent) {
    const linkElement = getEventLinkElement(event)

    if (!linkElement || linkElement !== targetElement.value || isRelatedTargetInsideKnownSurface(event.relatedTarget)) {
      return
    }

    scheduleClose()
  }

  function assignPreviewRef(element: LinkPreviewRefTarget) {
    previewElement.value = element instanceof HTMLElement ? element : null
  }

  function handlePreviewMouseEnter() {
    cancelClose()
  }

  function handlePreviewMouseLeave() {
    scheduleClose()
  }

  function edit() {
    const range = targetRange.value

    if (!range) {
      return
    }

    close()
    editor.chain().focus().setTextSelection(range).run()
    linkPanel.openSelection({
      source: 'preview-edit',
    })
  }

  function close() {
    clearTimers()
    isOpen.value = false
    targetElement.value = null
    targetRange.value = null
    href.value = ''
    text.value = ''
  }

  function scheduleOpen() {
    cancelOpen()
    openTimer = setTimeout(() => {
      openTimer = null
      isOpen.value = true
    }, LINK_PREVIEW_OPEN_DELAY)
  }

  function scheduleClose() {
    cancelOpen()
    cancelClose()
    closeTimer = setTimeout(close, LINK_PREVIEW_CLOSE_DELAY)
  }

  function clearTimers() {
    cancelOpen()
    cancelClose()
  }

  function cancelOpen() {
    if (!openTimer) {
      return
    }

    clearTimeout(openTimer)
    openTimer = null
  }

  function cancelClose() {
    if (!closeTimer) {
      return
    }

    clearTimeout(closeTimer)
    closeTimer = null
  }

  function updateVisiblePosition() {
    if (!isOpen.value || !targetElement.value) {
      return
    }

    updatePosition(targetElement.value)
  }

  function updatePosition(element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    const previewWidth = getPreviewWidth()
    const preferredLeft = rect.left + rect.width / 2 - previewWidth / 2
    const maxLeft = window.innerWidth - previewWidth - LINK_PREVIEW_SCREEN_GAP
    const left = Math.min(
      Math.max(LINK_PREVIEW_SCREEN_GAP, preferredLeft),
      Math.max(LINK_PREVIEW_SCREEN_GAP, maxLeft),
    )

    position.value = {
      left,
      top: rect.bottom + LINK_PREVIEW_GAP,
    }
  }

  function getPreviewWidth() {
    const measuredWidth = previewElement.value?.getBoundingClientRect().width ?? 0

    if (measuredWidth > 0) {
      return measuredWidth
    }

    return Math.min(LINK_PREVIEW_FALLBACK_WIDTH, window.innerWidth - LINK_PREVIEW_SCREEN_GAP * 2)
  }

  function resolveLinkPreviewTarget(element: HTMLAnchorElement): LinkPreviewTarget | null {
    const linkType = editor.schema.marks.link

    if (!linkType) {
      return null
    }

    const position = editor.view.posAtDOM(element, 0)
    const range = getMarkRange(editor.state.doc.resolve(position), linkType)

    if (!range) {
      return null
    }

    const href = getLinkHref(element, range)

    if (!href) {
      return null
    }

    return {
      element,
      href,
      range,
      text: editor.state.doc.textBetween(range.from, range.to, '\n'),
    }
  }

  function getLinkHref(element: HTMLAnchorElement, range: Range) {
    const linkType = editor.schema.marks.link
    let href = ''

    editor.state.doc.nodesBetween(range.from, range.to, (node) => {
      const mark = node.marks.find(item => item.type === linkType)

      if (mark && typeof mark.attrs.href === 'string') {
        href = mark.attrs.href
        return false
      }

      return undefined
    })

    return href || element.getAttribute('href') || element.href
  }

  function getEventLinkElement(event: MouseEvent) {
    const target = event.target

    if (!(target instanceof Element)) {
      return null
    }

    const linkElement = target.closest<HTMLAnchorElement>('a[href]')

    if (!linkElement || !editor.view.dom.contains(linkElement)) {
      return null
    }

    return linkElement
  }

  function isRelatedTargetInsideKnownSurface(target: EventTarget | null) {
    return target instanceof Node
      && Boolean(
        targetElement.value?.contains(target)
        || previewElement.value?.contains(target),
      )
  }

  return {
    isOpen,
    href,
    text,
    style,
    assignPreviewRef,
    close,
    edit,
    handlePreviewMouseEnter,
    handlePreviewMouseLeave,
  }
}
