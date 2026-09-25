import type { ExtensionApi, ExtensionStatus, ExtensionWorkbenchEvent } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchControl } from '@buddy-shared/workbench/workbenchUi'
import type { Ref } from 'vue'
import type { ExtensionViews } from '@/modules/extensions'
import type { ViewRendererRegistry } from '@/workbench/browser/ViewRendererRegistry'
import type { ViewLocation } from '@/workbench/common/workbench'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { matchesWorkbenchContext } from '@buddy-shared/workbench/workbenchContext'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { DesktopExtensionView } from '@/modules/extensions/ui'

export function useExtensionContributions(options: { controller: WorkbenchController, renderers: ViewRendererRegistry, persistence: WorkbenchPersistence, installed: Readonly<Ref<ExtensionStatus[]>>, api: ExtensionApi, views: ExtensionViews, ready: () => boolean }) {
  const { controller, renderers, persistence, installed, api, views } = options
  onScopeDispose(renderers.register('extensions.view', DesktopExtensionView))
  const owners = new Map<string, { revision: string, dispose: () => void }>()
  const configurationRevision = shallowRef(0)
  onScopeDispose(controller.configuration.subscribe(() => configurationRevision.value++))
  const selection = computed(() => {
    void configurationRevision.value
    return { 'model.reasoning': String(controller.configuration.get('workbench.controls.model.reasoning') ?? '') }
  })
  function select(target: WorkbenchControl, id: string) {
    if (id && !installed.value.some(item => item.enabled && item.compatible && item.manifest.contributes.placements.some(placement => placement.kind === 'control' && placement.target === target && placement.id === id)))
      return
    controller.configuration.set(`workbench.controls.${target}`, id)
  }
  watch(installed, (items) => {
    const enabled = items.filter(item => item.enabled && item.compatible)
    for (const [id, owner] of owners) {
      if (!enabled.some(item => item.manifest.id === id && item.revision === owner.revision)) {
        owner.dispose()
        owners.delete(id)
      }
    }
    for (const item of enabled) {
      const { id } = item.manifest
      if (owners.has(id))
        continue
      const dispose = controller.registry.register(`extension:${id}`, (scope) => {
        for (const view of item.manifest.contributes.views.filter(view => view.location === 'context')) {
          const locations: [ViewLocation, ...ViewLocation[]] = ['context', ...new Set(item.manifest.contributes.placements.flatMap(placement => placement.kind === 'view' && placement.view === view.id ? ['mount' as const] : []))]
          scope.view({ id: view.id, label: view.title, renderer: 'extensions.view', multiple: true, locations, when: view.when, supports: resource => resource.scheme === 'extension' && resource.data.extensionId === id && resource.data.viewType === view.id })
        }
        for (const placement of item.manifest.contributes.placements) {
          if (placement.kind === 'view')
            scope.placement({ id: placement.id, viewType: placement.view, location: 'mount', target: placement.target, presentation: placement.presentation, when: placement.when })
        }
        for (const command of item.manifest.contributes.commands.filter(command => !command.hidden)) {
          scope.command({ id: command.id, label: command.title, enabled: () => matchesWorkbenchContext(command.when, controller.contextKeys.snapshot()), execute: async ({ view }) => {
            const parsed = view && ['file', 'file-preview'].includes(view.resource.scheme) ? spaceFileTargetSchema.safeParse(view.resource.data) : null
            await api.execute(id, command.id, parsed?.success ? parsed.data : null)
          } })
        }
      })
      owners.set(id, { revision: item.revision, dispose })
    }
    reconcilePlacements()
    controller.changed()
  }, { immediate: true, flush: 'sync' })
  function reconcilePlacements() {
    if (!options.ready())
      return
    for (const view of Object.values(controller.layout.views)) {
      if (view.resource.scheme !== 'extension' || typeof view.resource.data.placementId !== 'string')
        continue
      const plugin = installed.value.find(item => item.manifest.id === view.resource.data.extensionId && item.enabled && item.compatible)
      const placement = plugin?.manifest.contributes.placements.find(placement => placement.id === view.resource.data.placementId && placement.kind === 'view')
      const descriptor = plugin?.manifest.contributes.views.find(descriptor => descriptor.id === placement?.view)
      if (!descriptor || placement?.kind !== 'view')
        continue
      if (view.type !== descriptor.id || view.location !== 'mount' || view.placement !== placement.id || view.title !== descriptor.title) {
        controller.rebindAuxiliary(view.id, { type: descriptor.id, placement: placement.id, title: descriptor.title, location: 'mount', resource: { ...view.resource, data: { ...view.resource.data, viewType: descriptor.id } } })
      }
    }
  }
  type RequestEvent = Exclude<ExtensionWorkbenchEvent, { kind: 'cancel' }>
  const requests = new Map<string, { event: RequestEvent, abort: AbortController, started: boolean }>()
  function drain() {
    if (!options.ready())
      return
    for (const request of requests.values()) {
      const { event, abort } = request
      if (event.kind === 'open' || event.kind === 'placement') {
        const plugin = installed.value.find(item => item.manifest.id === event.extensionId)
        const current = plugin?.enabled && plugin.compatible && plugin.generation === event.generation
        if (!current) {
          if (request.started)
            abort.abort()
          continue
        }
      }
      if (!request.started) {
        request.started = true
        void handle(event, abort.signal)
      }
    }
  }
  onScopeDispose(api.onWorkbench((event) => {
    if (event.kind === 'cancel') {
      requests.get(event.requestId)?.abort.abort()
      requests.delete(event.requestId)
      return
    }
    if (requests.size >= 64) {
      api.replyWorkbench(event.requestId, null)
      return
    }
    requests.set(event.requestId, { event, abort: new AbortController(), started: false })
    drain()
  }))
  watch([options.ready, installed], () => {
    reconcilePlacements()
    drain()
  }, { flush: 'sync' })
  async function handle(event: RequestEvent, signal: AbortSignal) {
    let viewId: string | null = null
    try {
      if (signal.aborted)
        return
      if (event.kind === 'control') {
        if (views.proposeControl(event.viewId, event.generation, event.token, event.proposal))
          viewId = event.viewId
      }
      else if (event.kind === 'placement') {
        const plugin = installed.value.find(item => item.manifest.id === event.extensionId && item.enabled && item.compatible)
        const placement = plugin?.manifest.contributes.placements.find(placement => placement.id === event.placementId)
        const descriptor = plugin?.manifest.contributes.views.find(view => view.id === placement?.view)
        if (placement?.kind !== 'view' || !descriptor)
          return
        const existing = Object.values(controller.layout.views).find(view => view.resource.scheme === 'extension' && view.resource.data.extensionId === event.extensionId && view.resource.data.placementId === placement.id)
        if (event.visible) {
          viewId = await controller.open({ scheme: 'extension', id: placement.id, data: { extensionId: event.extensionId, viewType: placement.view, resource: null, placementId: placement.id } }, descriptor.title, { signal, placement: placement.id, viewType: placement.view, location: 'mount', focus: false, state: { version: descriptor.stateVersion, value: {} } })
        }
        else if (existing && await controller.close(existing.id, signal)) {
          viewId = existing.id
        }
        await persistence.flush()
      }
      else if (event.kind === 'open') {
        const descriptor = installed.value.find(item => item.manifest.id === event.extensionId)?.manifest.contributes.views.find(view => view.id === event.viewType)
        if (!descriptor)
          return
        viewId = await controller.open({ scheme: 'extension', id: `${event.extensionId}:${event.viewType}:${event.resource?.id ?? crypto.randomUUID()}`, data: { extensionId: event.extensionId, viewType: event.viewType, resource: event.resource } }, event.resource?.name ?? descriptor.title, { signal, viewType: event.viewType, duplicate: true, state: { version: event.stateVersion, value: event.state } })
        if (viewId)
          await persistence.flush()
      }
      else {
        const view = controller.layout.views[event.viewId]
        const session = views.surfaces.get(event.viewId)?.session
        if (!view || view.resource.scheme !== 'extension' || session?.generation !== event.generation || session.token !== event.token)
          return
        if (event.kind === 'presentation') {
          const placement = view.placement ? controller.registry.placements.get(view.placement) : null
          if (!placement || placement.viewType !== view.type)
            return
          controller.updateView(view.id, { presentation: { ...view.presentation, ...event.presentation } })
        }
        else {
          controller.updateView(view.id, { state: { ...view.state, version: event.stateVersion, value: event.state } })
        }
        await persistence.flush()
        viewId = view.id
      }
    }
    catch {
      viewId = null
    }
    finally {
      requests.delete(event.requestId)
      if (!signal.aborted)
        api.replyWorkbench(event.requestId, viewId)
    }
  }
  onScopeDispose(() => {
    for (const { event, abort } of requests.values()) {
      abort.abort()
      api.replyWorkbench(event.requestId, null)
    }
    requests.clear()
    for (const owner of owners.values()) owner.dispose()
    owners.clear()
  })
  return { selection, select }
}
