import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { BrowserElementPickAnchor } from '@buddy-shared/browser/browserSelection'
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { Ref } from 'vue'
import type { SelectionReferenceRequest } from '@/shared/ui/selection/workbenchSelectionReferences'
import { useEventListener } from '@vueuse/core'
import { onBeforeUnmount, shallowRef, watch } from 'vue'
import { useSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'

/** Guest viewport ratios avoid mixing page zoom / device pixels with workbench CSS pixels. */
export function browserElementPickMenuPosition(anchor: BrowserElementPickAnchor, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>) {
  return { x: rect.left + anchor.x * rect.width, y: rect.top + anchor.y * rect.height }
}

export function useBrowserElementReference(options: {
  api: DesktopBrowserApi
  state: Readonly<Ref<DesktopBrowserState | null>>
  viewId: Readonly<Ref<string>>
  visible: Readonly<Ref<boolean>>
  feedback: (result: 'added' | 'duplicate' | 'limit' | 'unavailable', title?: string) => void
  choose: (request: SelectionReferenceRequest, anchor: BrowserElementPickAnchor) => void
}) {
  const references = useSelectionReferences()
  const picking = shallowRef(false)
  const targetLabel = shallowRef('')
  let active: { sessionId: string, requestId: string } | null = null
  let operation = 0
  function cancel() {
    operation += 1
    picking.value = false
    const current = active
    active = null
    if (current)
      void options.api.cancelElementPick(current.sessionId, current.requestId).catch(() => {})
  }
  async function toggle() {
    if (picking.value) {
      cancel()
      return
    }
    const state = options.state.value
    const scope = references?.captureScope(options.viewId.value)
    if (!state || !scope || !options.visible.value || state.controller === 'agent' || state.status !== 'ready')
      return
    if (!scope.targets.length) {
      options.feedback('unavailable')
      return
    }
    const id = ++operation
    const current = { sessionId: state.sessionId, requestId: crypto.randomUUID() }
    active = current
    picking.value = true
    targetLabel.value = scope.targets.find(target => target.id === scope.defaultId)?.label ?? ''
    try {
      const result = await options.api.pickElement(current.sessionId, current.requestId)
      if (id !== operation)
        return
      if (result.status === 'cancelled')
        return
      if (result.status !== 'selected') {
        options.feedback(result.status)
        return
      }
      const quote: BuddyResourceQuote = { id: crypto.randomUUID(), contentKind: 'element', text: result.text, source: result.source, element: result.element }
      const request = { ...scope, quote }
      if (!references!.isSourceCurrent(request)) {
        options.feedback('unavailable')
        return
      }
      if (request.defaultId && request.targets.length === 1)
        options.feedback(references!.add(request, request.defaultId), targetLabel.value)
      else
        options.choose(request, result.anchor)
    }
    catch {
      if (id === operation)
        options.feedback('unavailable')
    }
    finally {
      if (id === operation) {
        picking.value = false
        active = null
      }
    }
  }
  watch([options.viewId, options.visible, () => options.state.value?.sessionId, () => options.state.value?.pageId, () => options.state.value?.documentVersion, () => options.state.value?.url, () => options.state.value?.status, () => options.state.value?.controller], cancel, { flush: 'sync' })
  useEventListener(document, 'keydown', (event) => {
    if (picking.value && event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }, { capture: true })
  onBeforeUnmount(cancel)
  return { picking, targetLabel, toggle, cancel }
}
