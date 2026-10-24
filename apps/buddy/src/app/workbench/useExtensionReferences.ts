import type { ExtensionApi, ExtensionStatus, ExtensionWorkbenchEvent } from '@buddy-shared/extensions/extensionApi'
import type { Ref } from 'vue'
import type { TaskWorkspacePool } from './TaskWorkspacePool'
import type { ExtensionViews } from '@/modules/extensions'
import type { ReferenceTargetChoice } from '@/shared/ui/selection/useReferenceTargetPicker'
import type { SelectionReferenceNavigate, SelectionReferenceRequest, WorkbenchSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import type { WorkbenchController } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { isBuddyViewQuote } from '@buddy-shared/conversation/buddyUserContent'
import { extensionReferenceTargetSchema } from '@buddy-shared/extensions/extensionReferences'
import { nextTick, onScopeDispose, watch } from 'vue'
import { copyReferenceClipboard } from '@/shared/ui/selection/referenceClipboard'
import { receiveReferenceMaterial } from './receiveReferenceMaterial'

export function useExtensionReferences(options: {
  references: WorkbenchSelectionReferences
  controller: WorkbenchController
  persistence: WorkbenchPersistence
  pool: TaskWorkspacePool
  api: ExtensionApi
  views: ExtensionViews
  installed: Readonly<Ref<ExtensionStatus[]>>
  writeClipboard?: (text: string, html?: string) => Promise<void>
  chooseTarget: (scope: Omit<SelectionReferenceRequest, 'quote'>, title: string, signal: AbortSignal, allowClipboard: boolean) => Promise<ReferenceTargetChoice | null>
  prepareNewTaskInput: (sourceViewId: string, prepare: (viewId: string) => Promise<boolean>, signal: AbortSignal) => Promise<boolean>
  showTarget: (viewId: string) => Promise<void>
  showPage: (extensionId: string, navigate: SelectionReferenceNavigate) => Promise<boolean>
  notifySuccess: (result: { kind: 'view', title: string } | { kind: 'new-task' | 'clipboard' }) => void
}) {
  const { references, controller, views, api } = options
  const pending = new Set<string>()
  const lifetime = new AbortController()
  onScopeDispose(() => lifetime.abort())
  onScopeDispose(references.registerProvider('extensions', {
    captureSource(viewId) {
      const surface = views.surfaces.get(viewId)
      const session = surface?.session
      if (!surface?.visible || !surface.eligible || !surface.ready || surface.error || !session)
        return null
      return {
        identity: JSON.stringify([viewId, surface.input.extensionId, surface.input.viewType, surface.input.resource, session.generation, session.token]),
        owner: null,
      }
    },
    resolveLocate(quote) {
      if (!isBuddyViewQuote(quote) || !quote.source.provider.startsWith('extension:'))
        return null
      return async ({ current, signal, navigate }) => {
        const target = extensionReferenceTargetSchema.parse(quote.source.target)
        if (quote.source.provider !== `extension:${target.extensionId}`)
          return false
        const descriptor = options.installed.value.find(item => item.manifest.id === target.extensionId && item.enabled && item.compatible)?.manifest.contributes.views.find(view => view.id === target.viewType)
        if (!descriptor)
          return false
        if (descriptor.location === 'page') {
          if (target.source)
            return false
          await api.prepareReferenceOpening(target)
          if (!current() || !await options.showPage(target.extensionId, navigate) || !current())
            return false
          const page = await waitForPage(target.extensionId, target.viewType, current)
          const session = page?.session
          if (!page || !session || !current())
            return false
          await api.prepareReferenceOpening({ ...target, reuse: { id: session.id, generation: session.generation, token: session.token } })
          return current() && page.session === session && views.surfaces.get(session.id) === page
            && views.revealReference(session.id, { referenceId: quote.id, text: quote.text, locator: quote.locator ?? null }, signal)
        }
        const identity = JSON.stringify(target)
        const existing = Object.values(controller.layout.views).find(view => view.resource.scheme === 'extension' && view.resource.data.extensionId === target.extensionId && view.resource.data.viewType === target.viewType && view.state.referenceTarget === identity)
        const session = existing ? views.surfaces.get(existing.id)?.session : null
        const reuse = session ? { id: session.id, generation: session.generation, token: session.token } : undefined
        const prepared = await api.prepareReferenceOpening({ ...target, reuse })
        if (!current() || (existing && controller.layout.views[existing.id] !== existing)
          || (reuse && views.surfaces.get(reuse.id)?.session !== session)) {
          return false
        }
        if (existing && !reuse) {
          controller.updateView(existing.id, { resource: { ...existing.resource, data: { ...existing.resource.data, resource: prepared.resource } } })
          await nextTick()
        }
        const id = existing?.id ?? await controller.open({
          scheme: 'extension',
          id: `${prepared.extensionId}:${prepared.viewType}:${crypto.randomUUID()}`,
          data: { extensionId: prepared.extensionId, viewType: prepared.viewType, resource: prepared.resource },
        }, quote.source.title, { signal, viewType: prepared.viewType, duplicate: true, state: { version: descriptor.stateVersion, value: {}, referenceTarget: identity } })
        if (!id || !current())
          return false
        controller.focus(typeof existing?.state.inlineOwner === 'string' ? existing.state.inlineOwner : id)
        const ready = await waitForView(id, prepared.resource?.id ?? null, current)
        if (!ready || !current())
          return false
        await options.persistence.flush()
        return current() && views.revealReference(id, { referenceId: quote.id, text: quote.text, locator: quote.locator ?? null }, signal)
      }
    },
  }))

  function waitForPage(extensionId: string, viewType: string, current: () => boolean): Promise<ReturnType<typeof views.surfaces.get> | null> {
    return new Promise((resolve) => {
      let stop: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (page: ReturnType<typeof views.surfaces.get> | null) => {
        clearTimeout(timer)
        stop?.()
        resolve(page)
      }
      const check = () => {
        const page = [...views.surfaces.values()].find(surface => surface.input.extensionId === extensionId && surface.input.viewType === viewType && !surface.input.placementId && surface.visible)
        if (!current() || lifetime.signal.aborted || page?.error)
          finish(null)
        else if (page?.ready && page.eligible && page.session)
          finish(page)
      }
      timer = setTimeout(finish, 10000, null)
      stop = watch(() => [current(), ...[...views.surfaces.values()].map(surface => [surface.input.extensionId, surface.input.viewType, surface.visible, surface.ready, surface.eligible, surface.session, surface.error])], check, { flush: 'post' })
      check()
    })
  }

  function waitForView(id: string, resourceId: string | null, current: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      let stop: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: boolean) => {
        clearTimeout(timer)
        stop?.()
        resolve(value)
      }
      const check = () => {
        const surface = views.surfaces.get(id)
        if (!current() || lifetime.signal.aborted || surface?.error || !controller.layout.views[id])
          finish(false)
        else if (surface?.ready && surface.visible && surface.eligible && surface.session && (surface.input.resource?.id ?? null) === resourceId)
          finish(true)
      }
      timer = setTimeout(finish, 10000, false)
      stop = watch(() => [views.surfaces.get(id)?.ready, views.surfaces.get(id)?.error, views.surfaces.get(id)?.visible, views.surfaces.get(id)?.input.resource?.id, current()], check, { flush: 'post' })
      check()
    })
  }

  return {
    async receive(event: Extract<ExtensionWorkbenchEvent, { kind: 'reference' }>, signal: AbortSignal): Promise<boolean> {
      if (pending.has(event.viewId))
        return false
      const current = () => {
        const surface = views.surfaces.get(event.viewId)
        return !signal.aborted && !lifetime.signal.aborted && !!surface?.ready && surface.visible && surface.eligible && !surface.error
          && surface.session?.generation === event.generation && surface.session.token === event.token
      }
      if (!current())
        return false
      const scope = references.captureScope(event.viewId)
      if (!scope)
        return false
      pending.add(event.viewId)
      const abort = new AbortController()
      const stop = watch(current, valid => !valid && abort.abort(), { flush: 'sync' })
      try {
        const material = event.material
        const title = material.kind === 'quote' ? material.quote.source.title : material.kind === 'file' ? material.name : views.surfaces.get(event.viewId)?.input.resource?.name ?? ''
        const choice = await options.chooseTarget(scope, title, AbortSignal.any([signal, lifetime.signal, abort.signal]), material.kind === 'quote' && !!options.writeClipboard)
        if (!choice || !current())
          return false
        if (choice.kind === 'clipboard') {
          if (material.kind !== 'quote')
            return false
          if (!options.writeClipboard || !current())
            return false
          await copyReferenceClipboard(material.quote, options.writeClipboard)
          if (!current())
            return false
          options.notifySuccess({ kind: 'clipboard' })
          return true
        }
        const receive = async (targetId: string, opened: boolean) => {
          const target = references.targets().find(target => target.id === targetId)
          const targetScope = opened && !scope.targets.some(target => target.id === targetId) && target
            ? { ...scope, targets: [...scope.targets, { id: target.id, identity: target.identity, label: target.label }] }
            : scope
          const persisted = await receiveReferenceMaterial({ ...options, scope: targetScope, targetId, material, current })
          const captured = targetScope.targets.find(target => target.id === targetId)
          const accepted = persisted && current() && references.captureSource(scope.viewId)?.identity === scope.sourceIdentity
            && !!captured && references.targets().some(target => target.id === targetId && target.identity === captured.identity)
          if (accepted) {
            stop()
            if (material.kind === 'quote') {
              const view = controller.layout.views[event.viewId]
              if (view)
                controller.updateView(view.id, { state: { ...view.state, referenceTarget: JSON.stringify(material.quote.source.target) } })
            }
          }
          return accepted
        }
        if (choice.kind === 'view') {
          const accepted = await receive(choice.id, false)
          if (accepted) {
            await options.showTarget(choice.id)
            const target = scope.targets.find(target => target.id === choice.id)!
            options.notifySuccess({ kind: 'view', title: target.pane?.title ?? target.label })
          }
          return accepted
        }
        const accepted = await options.prepareNewTaskInput(event.viewId, id => receive(id, true), AbortSignal.any([signal, lifetime.signal, abort.signal]))
        if (accepted)
          options.notifySuccess({ kind: 'new-task' })
        return accepted
      }
      finally {
        stop()
        pending.delete(event.viewId)
      }
    },
  }
}
