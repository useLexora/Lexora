import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { Ref } from 'vue'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { onScopeDispose, watch } from 'vue'
import { DesktopExtensionView } from '@/modules/extensions/ui'

export function useExtensionContributions(controller: WorkbenchController, persistence: WorkbenchPersistence, installed: Readonly<Ref<ExtensionStatus[]>>, api: ExtensionApi, generation: (id: string) => string | null) {
  const owners = new Map<string, { revision: string, dispose: () => void }>()
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
        for (const view of item.manifest.contributes.views.filter(view => view.location === 'context')) scope.view({ id: view.id, label: view.title, factory: DesktopExtensionView, multiple: true, location: 'context', supports: resource => resource.scheme === 'extension' && resource.data.extensionId === id && resource.data.viewType === view.id })
        for (const command of item.manifest.contributes.commands.filter(command => !command.hidden)) {
          scope.command({ id: command.id, label: command.title, execute: async ({ view }) => {
            const parsed = view && ['file', 'file-preview'].includes(view.resource.scheme) ? spaceFileTargetSchema.safeParse(view.resource.data) : null
            await api.execute(id, command.id, parsed?.success ? parsed.data : null)
          } })
        }
      })
      owners.set(id, { revision: item.revision, dispose })
    }
    controller.changed()
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(api.onWorkbench(async (event) => {
    let viewId: string | null = null
    try {
      if (event.kind === 'open') {
        const descriptor = installed.value.find(item => item.manifest.id === event.extensionId)?.manifest.contributes.views.find(view => view.id === event.viewType)
        if (!descriptor)
          return
        viewId = await controller.open({ scheme: 'extension', id: `${event.extensionId}:${event.viewType}:${event.resource?.id ?? crypto.randomUUID()}`, data: { extensionId: event.extensionId, viewType: event.viewType, resource: event.resource } }, event.resource?.name ?? descriptor.title, { viewType: event.viewType, duplicate: true })
        if (!viewId)
          return
        controller.updateView(viewId, { state: { version: event.stateVersion, value: event.state } })
        await persistence.flush()
      }
      else {
        const view = controller.layout.views[event.viewId]
        if (!view || view.resource.scheme !== 'extension' || generation(event.viewId) !== event.generation)
          return
        controller.updateView(view.id, { state: { ...view.state, version: event.stateVersion, value: event.state } })
        await persistence.flush()
        viewId = view.id
      }
    }
    catch {
      viewId = null
    }
    finally {
      api.replyWorkbench(event.requestId, viewId)
    }
  }))
  onScopeDispose(() => {
    for (const owner of owners.values()) owner.dispose()
    owners.clear()
  })
}
