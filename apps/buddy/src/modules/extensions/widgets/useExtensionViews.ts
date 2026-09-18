import type { ExtensionApi, ExtensionStatus, ExtensionViewInput, ExtensionViewSession } from '@buddy-shared/extensions/extensionApi'
import type { Ref } from 'vue'
import { onScopeDispose, shallowReactive, watch } from 'vue'
import { extensionErrorCode } from '../state/useExtensionState'

export interface ExtensionSurface {
  input: ExtensionViewInput
  element: HTMLElement
  visible: boolean
  session: ExtensionViewSession | null
  opening: boolean
  error: string
}

export function useExtensionViews(api: ExtensionApi, installed: Readonly<Ref<ExtensionStatus[]>>) {
  const surfaces = shallowReactive(new Map<string, ExtensionSurface>())
  let layout = () => {}
  const close = (session: ExtensionViewSession) => void api.closeView(session.id, session.generation, session.token).catch(() => {})
  async function open(surface: ExtensionSurface) {
    surface.opening = true
    surface.error = ''
    try {
      const session = await api.openView(surface.input)
      if (surfaces.get(surface.input.viewId) !== surface) {
        close(session)
        return
      }
      surface.session = session
    }
    catch (error) {
      surface.error = extensionErrorCode(error)
    }
    finally {
      surface.opening = false
    }
  }
  function reconcile() {
    for (const surface of surfaces.values()) {
      const status = installed.value.find(item => item.manifest.id === surface.input.extensionId)
      if (surface.session && surface.session.generation !== status?.generation) {
        close(surface.session)
        surface.session = null
      }
      if (!status?.enabled || !status.compatible || ['failed', 'blocked'].includes(status.state)) {
        surface.error = status?.error ?? 'EXTENSION_VIEW_UNAVAILABLE'
        continue
      }
      if (!surface.session && !surface.opening && !surface.error)
        void open(surface)
      else if (!surface.session && !surface.opening && status.state === 'inactive' && !status.error)
        void open(surface)
    }
  }
  watch(installed, reconcile, { flush: 'post' })
  function show(input: ExtensionViewInput, element: HTMLElement, visible: boolean) {
    const previous = surfaces.get(input.viewId)
    if (previous) {
      previous.input = input
      previous.element = element
      previous.visible = visible
    }
    else {
      surfaces.set(input.viewId, shallowReactive({ input, element, visible, session: null, opening: false, error: '' }))
      reconcile()
    }
    layout()
  }
  function hide(id: string) {
    const surface = surfaces.get(id)
    if (surface?.session)
      close(surface.session)
    surfaces.delete(id)
    layout()
  }
  onScopeDispose(() => {
    for (const id of surfaces.keys()) hide(id)
  })
  return { surfaces, show, hide, layout: () => layout(), setLayout: (callback: () => void) => {
    layout = callback
  } }
}
