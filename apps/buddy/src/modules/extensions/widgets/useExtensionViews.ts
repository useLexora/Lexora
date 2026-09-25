import type { ExtensionApi, ExtensionStatus, ExtensionViewInput, ExtensionViewSession } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchContextValues } from '@buddy-shared/workbench/workbenchContext'
import type { ControlProposal, ControlSnapshot, WorkbenchMountTarget } from '@buddy-shared/workbench/workbenchUi'
import type { Ref } from 'vue'
import type { SemanticAnchor } from '@/shared/ui/contributions/workbenchUiContext'
import { matchesWorkbenchContext } from '@buddy-shared/workbench/workbenchContext'
import { onScopeDispose, shallowReactive, watch } from 'vue'
import { extensionErrorCode } from '../state/useExtensionState'

export interface ExtensionControlBinding {
  snapshot: () => ControlSnapshot
  dismiss: () => void
  propose: (proposal: ControlProposal) => boolean
}
export interface ExtensionSurface {
  input: ExtensionViewInput
  element: HTMLElement
  visible: boolean
  eligible: boolean
  session: ExtensionViewSession | null
  opening: boolean
  ready: boolean
  anchor: SemanticAnchor | null
  mount: { target: WorkbenchMountTarget, element: HTMLElement } | null
  control: ExtensionControlBinding | null
  error: string
}
interface SurfaceLifecycle {
  revision: string | null
  generation: string | null
  request: number
}
interface ControlFailure {
  extensionId: string
  revision: string | null
  generation: string | null
  error: string
}

function identity(input: ExtensionViewInput): string {
  return JSON.stringify([input.extensionId, input.viewType, input.placementId, input.resource])
}

export function useExtensionViews(api: ExtensionApi, installed: Readonly<Ref<ExtensionStatus[]>>, context: Readonly<Ref<WorkbenchContextValues>>) {
  const surfaces = shallowReactive(new Map<string, ExtensionSurface>())
  const lifecycles = new WeakMap<ExtensionSurface, SurfaceLifecycle>()
  const controlFailures = new Map<string, ControlFailure>()
  let layout = () => {}
  const close = (session: ExtensionViewSession) => void api.closeView(session.id, session.generation, session.token).catch(() => {})
  function reset(surface: ExtensionSurface) {
    lifecycles.get(surface)!.request++
    if (surface.session)
      close(surface.session)
    surface.session = null
    surface.opening = false
    surface.ready = false
    surface.error = ''
  }
  async function open(surface: ExtensionSurface) {
    const lifecycle = lifecycles.get(surface)!
    const request = ++lifecycle.request
    const input = surface.input
    const current = () => surfaces.get(input.viewId) === surface && lifecycle.request === request
    surface.opening = true
    surface.ready = false
    surface.error = ''
    try {
      const session = await api.openView(input)
      if (!current()) {
        close(session)
        return
      }
      const status = installed.value.find(item => item.manifest.id === input.extensionId)
      if (!status?.enabled || !status.compatible || status.revision !== lifecycle.revision || (status.generation && status.generation !== session.generation)) {
        close(session)
        return
      }
      lifecycle.generation = session.generation
      surface.session = session
    }
    catch (error) {
      if (current())
        fail(surface, extensionErrorCode(error))
    }
    finally {
      if (current())
        surface.opening = false
    }
  }
  function reconcile() {
    for (const [id, failure] of controlFailures) {
      const status = installed.value.find(item => item.manifest.id === failure.extensionId)
      if (!status || status.revision !== failure.revision || (status.generation && failure.generation && status.generation !== failure.generation))
        controlFailures.delete(id)
      else if (status.generation)
        failure.generation = status.generation
    }
    for (const surface of surfaces.values()) {
      const status = installed.value.find(item => item.manifest.id === surface.input.extensionId)
      const lifecycle = lifecycles.get(surface)!
      const manifest = status?.manifest
      const view = manifest?.contributes.views.find(view => view.id === surface.input.viewType)
      const placement = manifest?.contributes.placements.find(placement => placement.id === surface.input.placementId)
      surface.eligible = matchesWorkbenchContext(view?.when, context.value) && matchesWorkbenchContext(placement?.when, context.value)
      if (!status?.enabled || !status.compatible || ['failed', 'blocked'].includes(status.state)) {
        reset(surface)
        lifecycle.revision = null
        lifecycle.generation = null
        surface.error = status?.error ?? 'EXTENSION_VIEW_UNAVAILABLE'
        continue
      }
      if (lifecycle.revision !== status.revision || (lifecycle.generation && lifecycle.generation !== status.generation))
        reset(surface)
      lifecycle.revision = status.revision
      lifecycle.generation = status.generation
      const failure = surface.control && surface.input.placementId ? controlFailures.get(surface.input.placementId) : null
      if (failure) {
        reset(surface)
        surface.error = failure.error
        continue
      }
      if (surface.control && surface.input.placementId && surface.error)
        reset(surface)
      if (surface.eligible && !surface.session && !surface.opening && !surface.error)
        void open(surface)
    }
  }
  watch([installed, context], () => {
    reconcile()
    layout()
  }, { flush: 'sync' })
  function show(input: ExtensionViewInput, element: HTMLElement, visible: boolean, binding?: { anchor?: SemanticAnchor, control?: ExtensionControlBinding, mount?: ExtensionSurface['mount'] }) {
    const previous = surfaces.get(input.viewId)
    if (previous) {
      if (identity(previous.input) !== identity(input))
        reset(previous)
      previous.input = input
      previous.element = element
      previous.visible = visible
      previous.mount = binding?.mount ?? null
      previous.anchor = binding?.anchor ?? null
      previous.control = binding?.control ?? null
    }
    else {
      const surface = shallowReactive<ExtensionSurface>({ input, element, visible, eligible: true, session: null, opening: false, ready: false, mount: binding?.mount ?? null, anchor: binding?.anchor ?? null, control: binding?.control ?? null, error: '' })
      lifecycles.set(surface, { revision: null, generation: null, request: 0 })
      surfaces.set(input.viewId, surface)
    }
    reconcile()
    layout()
  }
  function hide(id: string) {
    const surface = surfaces.get(id)
    if (surface)
      reset(surface)
    surfaces.delete(id)
    layout()
  }
  function fail(surface: ExtensionSurface, error: string) {
    if (surfaces.get(surface.input.viewId) !== surface)
      return
    const session = surface.session
    if (session && error === 'EXTENSION_VIEW_TIMEOUT')
      void api.viewRequest(session.id, session.generation, session.token, 'view.failed', { code: error }).catch(() => {})
    if (surface.control && surface.input.placementId) {
      const lifecycle = lifecycles.get(surface)!
      controlFailures.set(surface.input.placementId, { extensionId: surface.input.extensionId, revision: lifecycle.revision, generation: lifecycle.generation, error })
    }
    reset(surface)
    surface.error = error
    reconcile()
    layout()
  }
  function retryControl(placementId: string) {
    if (!controlFailures.delete(placementId))
      return
    reconcile()
    layout()
  }
  function proposeControl(id: string, generation: string, token: string, proposal: ControlProposal): boolean {
    const surface = surfaces.get(id)
    return !!surface?.ready && surface.eligible && surface.visible && !surface.error && surface.session?.generation === generation && surface.session.token === token && !!surface.control?.propose(proposal)
  }
  onScopeDispose(() => {
    for (const id of surfaces.keys()) hide(id)
  })
  return { surfaces, show, hide, fail, retryControl, proposeControl, layout: () => layout(), setLayout: (callback: () => void) => {
    layout = callback
  } }
}

export type ExtensionViews = ReturnType<typeof useExtensionViews>
