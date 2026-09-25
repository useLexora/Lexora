import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { Router } from 'vue-router'
import type { DesktopStores } from '../bootstrap/useDesktopAppState'
import type { TaskIndexController } from '@/modules/tasks'
import type { TaskCapability, TaskResourcePanel } from '@/modules/tasks/contracts'
import type { ChatReadingPositions } from '@/modules/tasks/ui'
import type { DropPosition, ResourceRef, SplitDirection, WorkbenchView } from '@/workbench/common/workbench'
import type { ViewCloseDecision } from '@/workbench/services/WorkbenchController'
import { buddyUserContentToText, getBuddyUserContentResourceIds, hasBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { isSkillAvailable } from '@buddy-shared/skills/skillApi'
import { NButton, useDialog } from 'naive-ui'
import { h, onScopeDispose, shallowReactive, shallowRef } from 'vue'
import { userContentToChatComposerDocument } from '@/modules/prompt-input'
import { TextModelPool } from '@/workbench/browser/TextModelPool'
import { ViewRendererRegistry } from '@/workbench/browser/ViewRendererRegistry'
import { panes, resourceKey } from '@/workbench/common/workbench'
import { workbenchLabels } from '@/workbench/common/workbenchLabels'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { registerDesktopContributions } from './registerDesktopContributions'
import { restoreTaskInputViews } from './restoreTaskInputViews'
import { TaskWorkspacePool } from './TaskWorkspacePool'
import { useTaskInputLifecycle } from './useTaskInputLifecycle'

export function useDesktopWorkbench(options: { api: LexoraDesktopApi, stores: DesktopStores, taskIndex: TaskIndexController, router: Router, resources: () => TaskResourcePanel, onError: (error: unknown) => void }) {
  const { api, stores, router } = options
  const dialog = useDialog()
  const language = stores.applicationSettings.language
  const labels = () => workbenchLabels(language.value)
  const activeTask = shallowRef<TaskCapability | null>(null)
  const readingPositions: ChatReadingPositions = new Map()
  const backupError = shallowRef(false)
  const fileToolbarTargets = shallowReactive(new Map<string, HTMLElement>())
  const openingFiles = new Map<string, Promise<string | null | undefined>>()
  const copies = new WorkingCopyService({
    read: resource => api.localChat.spaces.readDocument(resource.data as unknown as SpaceFileTarget),
    save: (resource, document) => api.localChat.spaces.saveDocument({ ...resource.data as unknown as SpaceFileTarget, ...document }),
  })
  const controller = new WorkbenchController(new ContributionRegistry(), beforeClose)
  const models = new TextModelPool(copies)
  const renderers = new ViewRendererRegistry()
  registerDesktopContributions(controller, renderers, copies, () => language.value)
  const persistence = new WorkbenchPersistence(api.workbench, controller, copies, error => backupError.value = error !== null)
  const pool = new TaskWorkspacePool({ api, index: options.taskIndex, applicationSettings: stores.applicationSettings, modelProviders: stores.modelProviders, runtimeSupervisor: stores.runtimeSupervisor, onDraftCommitted: (draftId, id) => options.resources().adoptDraft(draftId, id) }, (previous, task, id) => {
    for (const view of Object.values(controller.layout.views)) {
      if (resourceKey(view.resource) === resourceKey(previous))
        controller.updateView(view.id, { resource: { scheme: 'task', id, data: {} }, title: task.session.currentTitle.value })
    }
    void options.taskIndex.index.refresh()
  }, () => persistence.flush())
  const inputs = useTaskInputLifecycle({
    api,
    controller,
    persistence,
    pool,
    resources: options.resources,
    onError: options.onError,
    prepareFileClose: beforeFileClose,
  })
  const confirmedDraftCloses = new Set<string>()
  const deletedTasks = new Set<string>()
  const initialized = shallowRef(false)
  let navigationVersion = 0
  onScopeDispose(router.beforeEach((to) => {
    if (to.path !== '/tasks')
      navigationVersion += 1
  }))

  function center(): string {
    return controller.pane(controller.layout.activePane)?.id ?? panes(controller.layout.root)[0]!.id
  }
  function openTask(id: string, signal?: AbortSignal): Promise<void> {
    return activateTask({ scheme: 'task', id, data: {} }, options.taskIndex.index.tasks.value.find(task => task.id === id)?.title ?? labels().tasks, { signal })
  }
  function newTask(spaceId?: string | null, paneId = center(), direction?: SplitDirection): Promise<void> {
    return activateTask({ scheme: 'draft', id: crypto.randomUUID(), data: { spaceId: spaceId ?? null } }, labels().newTask, { paneId, direction })
  }
  async function startTaskWithSkill(name: string, prompt: string): Promise<void> {
    const version = navigationVersion
    const catalog = await api.localChat.skills.list(null)
    if (version !== navigationVersion)
      return
    const skill = catalog.skills.find(skill => skill.name === name && isSkillAvailable(skill))
    if (!skill)
      throw new Error('SKILL_UNAVAILABLE')
    const content: BuddyUserContentV1 = { version: 1, panelResourceIds: [], body: [{ type: 'paragraph', content: [
      { type: 'prompt_directive', directive: 'skill', value: skill.name, skill: { id: skill.id, name: skill.name, revision: skill.revision } },
      { type: 'text', text: ` ${prompt}` },
    ] }] }
    await activateTask({ scheme: 'draft', id: crypto.randomUUID(), data: { spaceId: null } }, labels().newTask, { initialContent: content })
  }
  async function isDraftDirty(view: WorkbenchView): Promise<boolean> {
    if (view.resource.scheme !== 'draft')
      return false
    const task = pool.peek(view.resource)
    if (task) {
      const text = task.workspace.composer.draft.value.trim()
      const resources = task.workspace.composer.resources.value.length
      const quotes = ((task.workspace.composer.composerContent.value?.attrs as { quotes?: unknown[] } | undefined)?.quotes?.length ?? 0) > 0
      return Boolean(text || resources || quotes)
    }
    try {
      const draft = await api.localChat.composerDrafts.get(view.resource.id)
      return hasBuddyUserContent(draft.content)
    }
    catch {
      return false
    }
  }

  function promptUnsentDraftAction(): Promise<'split' | 'discard' | 'cancel'> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (choice: 'split' | 'discard' | 'cancel') => {
        if (!settled) {
          settled = true
          resolve(choice)
        }
      }
      const modal = dialog.warning({
        title: labels().unsentDraftPrompt,
        content: labels().unsentDraftDetail,
        closable: true,
        onClose: () => finish('cancel'),
        onMaskClick: () => finish('cancel'),
        onEsc: () => finish('cancel'),
        action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' }, [
          h(NButton, {
            size: 'small',
            onClick: () => {
              finish('cancel')
              modal.destroy()
            },
          }, () => labels().cancel),
          h(NButton, {
            size: 'small',
            type: 'error',
            onClick: () => {
              finish('discard')
              modal.destroy()
            },
          }, () => labels().discardDraft),
          h(NButton, {
            size: 'small',
            type: 'primary',
            onClick: () => {
              finish('split')
              modal.destroy()
            },
          }, () => labels().splitOpen),
        ]),
      })
    })
  }

  function promptUnsentDraftCloseAction(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (confirmed: boolean) => {
        if (!settled) {
          settled = true
          resolve(confirmed)
        }
      }
      const modal = dialog.warning({
        title: labels().unsentDraftPrompt,
        content: labels().unsentDraftCloseDetail,
        closable: true,
        onClose: () => finish(false),
        onMaskClick: () => finish(false),
        onEsc: () => finish(false),
        action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' }, [
          h(NButton, {
            size: 'small',
            onClick: () => {
              finish(false)
              modal.destroy()
            },
          }, () => labels().cancel),
          h(NButton, {
            size: 'small',
            type: 'error',
            onClick: () => {
              finish(true)
              modal.destroy()
            },
          }, () => labels().discardDraft),
        ]),
      })
    })
  }

  async function activateTask(resource: ResourceRef, title: string, destination: { paneId?: string, direction?: SplitDirection, move?: boolean, signal?: AbortSignal, initialContent?: BuddyUserContentV1 } = {}) {
    const targetPaneId = destination.paneId ?? center()
    const targetPane = controller.pane(targetPaneId)
    const currentViewId = targetPane?.view
    const currentView = currentViewId ? controller.layout.views[currentViewId] : null

    const isExistingTask = Object.values(controller.layout.views).some(view =>
      resourceKey(view.resource) === resourceKey(resource)
      && (view.location === 'main' || view.location === undefined),
    )

    if (!destination.direction && !isExistingTask && currentView && currentView.resource.scheme === 'draft') {
      if (resource.scheme === 'draft' && !destination.initialContent) {
        const currentSpaceId = (currentView.resource.data.spaceId as string | null) ?? null
        const targetSpaceId = (resource.data.spaceId as string | null) ?? null
        if (currentSpaceId === targetSpaceId) {
          controller.focus(currentView.id)
          await router.push('/tasks')
          return
        }
      }
      if (await isDraftDirty(currentView)) {
        if (destination.initialContent)
          return activateTask(resource, title, { ...destination, direction: 'right' })
        const action = await promptUnsentDraftAction()
        if (action === 'cancel') {
          controller.focus(currentView.id)
          return
        }
        if (action === 'split') {
          return activateTask(resource, title, { ...destination, direction: 'right' })
        }
        confirmedDraftCloses.add(currentView.id)
      }
    }

    const version = ++navigationVersion
    let id: string | null = null
    try {
      id = await controller.open(resource, title, { paneId: targetPaneId, ...destination })
    }
    finally {
      if (currentView)
        confirmedDraftCloses.delete(currentView.id)
    }
    if (!id || destination.signal?.aborted || version !== navigationVersion)
      return
    await router.push('/tasks')
    try {
      const task = await pool.open(resource)
      if (!destination.signal?.aborted && controller.layout.views[id] && version === navigationVersion && controller.owner(id)?.id === controller.layout.activePane) {
        activeTask.value = task
        if (destination.initialContent) {
          task.workspace.composer.updateComposerContent(buddyUserContentToText(destination.initialContent), userContentToChatComposerDocument(destination.initialContent))
          await task.flushDrafts()
        }
      }
    }
    catch (error) {
      if (controller.layout.views[id])
        options.onError(error)
    }
  }
  function dropResource(resource: ResourceRef, paneId: string, position: DropPosition) {
    if (!['task', 'draft'].includes(resource.scheme))
      return
    return activateTask(resource, options.taskIndex.index.tasks.value.find(task => task.id === resource.id)?.title ?? labels().newTask, { paneId, direction: position === 'center' ? undefined : position, move: true })
  }
  function fileView(target: SpaceFileTarget, tabId?: string) {
    return Object.values(controller.layout.views).find(view => ['file', 'file-preview'].includes(view.resource.scheme)
      && view.resource.id === JSON.stringify([target.directoryId, target.revision, target.path])
      && view.state.contextTabId === tabId)
  }
  function contextViews(tabIds: readonly string[]) {
    const ids = new Set(tabIds)
    return Object.values(controller.layout.views).filter(view => ids.has(view.id) || (typeof view.state.contextTabId === 'string' && ids.has(view.state.contextTabId))).map(view => view.id)
  }
  async function closeContextFiles(tabId: string) {
    return controller.closeMany(contextViews([tabId]))
  }
  function openFile(target: SpaceFileTarget, tabId?: string) {
    const key = JSON.stringify([tabId, target.directoryId, target.revision, target.path])
    const pending = openingFiles.get(key)
    if (pending)
      return pending
    const opening = createFile(target, tabId).finally(() => openingFiles.delete(key))
    openingFiles.set(key, opening)
    return opening
  }
  async function createFile(target: SpaceFileTarget, tabId?: string) {
    const previous = fileView(target, tabId)
    if (previous) {
      if (!tabId)
        controller.focus(previous.id)
      return previous.id
    }
    const resource: ResourceRef = { scheme: 'file', id: JSON.stringify([target.directoryId, target.revision, target.path]), data: { ...target } }
    const copy = await copies.open(resource)
    if (!copy.etag && copy.error) {
      copies.release(resource)
      resource.scheme = 'file-preview'
    }
    if (tabId && !options.resources().hasTab(tabId)) {
      copies.release(resource)
      return null
    }
    if (tabId)
      return controller.open(resource, target.path.split('/').at(-1) ?? target.path, { duplicate: true, focus: false, state: { contextTabId: tabId } })
    const existing = options.resources().tabs.value.find(tab => tab.kind === 'view' && resourceKey(controller.layout.views[tab.viewId]?.resource ?? { scheme: '', id: '', data: {} }) === resourceKey(resource))
    if (existing?.kind === 'view')
      controller.focus(existing.viewId)
    else
      return controller.open(resource, target.path.split('/').at(-1) ?? target.path, { duplicate: true })
  }

  controller.registry.register('lexora.navigation', (scope) => {
    scope.command({ id: 'task.new', get label() {
      return labels().newTask
    }, keybinding: 'Mod+N', execute: () => newTask() })
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      scope.command({ id: `view.split.${direction}`, get label() {
        return labels()[direction === 'right' ? 'split' : direction === 'down' ? 'splitDown' : direction === 'left' ? 'splitLeft' : 'splitUp']
      }, keybinding: direction === 'right' ? 'Mod+\\' : direction === 'down' ? 'Mod+Shift+\\' : undefined, execute: () => newTask(activeTask.value?.session.spaceId.value, center(), direction) })
    }
    scope.command({ id: 'context.close', get label() {
      return labels().closeContext
    }, keybinding: 'Mod+W', shortcutScope: 'context', enabled: context => context.values['focus.area'] === 'context' && !!options.resources().activeTab.value, execute: () => {
      const tab = options.resources().activeTab.value
      if (tab)
        return options.resources().closeTab(tab.id)
    } })
    scope.command({ id: 'resource.browser', get label() {
      return labels().browser
    }, execute: () => options.resources().addBrowser() })
    scope.command({ id: 'resource.changes', get label() {
      return labels().output
    }, execute: () => options.resources().openChanges() })
    scope.command({ id: 'resource.files', get label() {
      return labels().files
    }, execute: () => {
      const spaceId = activeTask.value?.session.spaceId.value
      if (spaceId)
        options.resources().openFiles(spaceId)
    } })
  })

  async function initialize() {
    if (initialized.value)
      return
    const restored = await persistence.restore(layout => restoreTaskInputViews(layout, api.localChat.composerDrafts))
    const legacyDraftViews = Object.values(controller.layout.views).filter(view => view.resource.scheme === 'draft' && (view.resource.id === 'global' || view.resource.id === view.resource.data.spaceId))
    if (legacyDraftViews.length) {
      const drafts = await api.localChat.composerDrafts.list()
      for (const view of legacyDraftViews) {
        const previous = drafts.find(draft => draft.scope.kind === 'task'
          && draft.scope.spaceId === (view.resource.data.spaceId ?? null)
          && (buddyUserContentToText(draft.content).trim() || getBuddyUserContentResourceIds(draft.content).length))
        controller.updateView(view.id, { resource: { ...view.resource, id: previous?.draftId ?? crypto.randomUUID() } })
      }
    }
    const resources = options.resources()
    resources.restoreSnapshot(controller.layout.auxiliary.context)
    const legacy = controller.layout.auxiliary.legacyResources
    if (Array.isArray(legacy))
      legacy.forEach(resources.restoreTab)
    delete controller.layout.auxiliary.legacyResources
    if (!restored && !panes(controller.layout.root).some(pane => pane.view)) {
      const previous = await api.localChat.workspaceState.read()
      const id = previous?.value.activeConversationId
      if (id)
        await openTask(id)
      else
        await newTask(previous?.value.spaceId)
    }
    initialized.value = true
    controller.changed()
    await inputs.restore(restored)
  }

  async function prepareTaskDeletion(id: string): Promise<boolean> {
    return controller.closeMany(contextViews(options.resources().allTabs.value.filter(tab => tab.scope === `task:${id}`).map(tab => tab.id)))
  }

  function discardTask(id: string) {
    deletedTasks.add(id)
    options.resources().discardConversation(id)
    for (const view of Object.values(controller.layout.views)) {
      if (view.resource.scheme === 'task' && view.resource.id === id)
        void controller.close(view.id).catch(options.onError)
    }
  }

  async function beforeClose(view: WorkbenchView, closing?: ReadonlySet<string>): Promise<ViewCloseDecision> {
    if (view.resource.scheme === 'task' && deletedTasks.has(view.resource.id))
      return true
    if (view.resource.scheme === 'draft' && !confirmedDraftCloses.has(view.id)) {
      if (await isDraftDirty(view)) {
        const confirmed = await promptUnsentDraftCloseAction()
        if (!confirmed)
          return false
        confirmedDraftCloses.add(view.id)
      }
    }
    try {
      return ['task', 'draft'].includes(view.resource.scheme) ? await inputs.prepareClose(view) : await beforeFileClose(view, closing)
    }
    catch (error) {
      options.onError(error)
      return false
    }
    finally {
      confirmedDraftCloses.delete(view.id)
    }
  }

  async function beforeFileClose(view: WorkbenchView, closing: ReadonlySet<string> = new Set()): Promise<ViewCloseDecision> {
    const first = [...closing].find(id => resourceKey(controller.layout.views[id]?.resource ?? { scheme: '', id: '', data: {} }) === resourceKey(view.resource))
    if (first && first !== view.id)
      return true
    if (Object.values(controller.layout.views).some(other => other.id !== view.id && !closing.has(other.id) && resourceKey(other.resource) === resourceKey(view.resource)))
      return true
    if (!copies.dirty(view.resource))
      return true
    return new Promise<ViewCloseDecision>((resolve) => {
      let settled = false
      const finish = (value: ViewCloseDecision) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      const modal = dialog.warning({
        title: labels().savePrompt,
        content: view.title,
        onClose: () => finish(false),
        onMaskClick: () => finish(false),
        onEsc: () => finish(false),
        action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;width:100%' }, [
          h(NButton, {
            size: 'small',
            onClick: () => {
              finish(false)
              modal.destroy()
            },
          }, () => labels().cancel),
          h(NButton, {
            size: 'small',
            type: 'error',
            onClick: () => {
              finish({ commit: () => copies.discard(view.resource), complete: () => persistence.flush().catch(options.onError) })
              modal.destroy()
            },
          }, () => labels().discard),
          h(NButton, {
            size: 'small',
            type: 'primary',
            onClick: async () => {
              if (await copies.save(view.resource)) {
                try {
                  await persistence.flush()
                  finish(true)
                  modal.destroy()
                }
                catch {
                  finish(false)
                  modal.destroy()
                }
              }
            },
          }, () => labels().save),
        ]),
      })
    })
  }

  onScopeDispose(controller.subscribe(() => {
    if (!initialized.value)
      return
    const resources = options.resources()
    pool.retain(Object.values(controller.layout.views).map(view => view.resource))
    const referencedFiles = new Set(Object.values(controller.layout.views).map(view => resourceKey(view.resource)))
    for (const copy of copies.copies.values()) {
      if (!referencedFiles.has(resourceKey(copy.resource)))
        copies.release(copy.resource)
    }
    const pane = controller.pane(controller.layout.activePane)
    const view = pane?.view ? controller.layout.views[pane.view] : null
    const task = view ? pool.peek(view.resource) : null
    if (task || !view)
      activeTask.value = task ?? null
    for (const tab of resources.allTabs.value) {
      if (tab.kind === 'view' && !controller.layout.views[tab.viewId])
        resources.removeView(tab.id)
    }
    for (const view of Object.values(controller.layout.views)) {
      if (view.location !== 'context')
        continue
      if (typeof view.state.contextTabId === 'string')
        continue
      if (!resources.hasTab(view.id)) {
        resources.openView(view.id, view.title)
      }
      else {
        const tab = resources.allTabs.value.find(tab => tab.id === view.id)
        if (tab?.kind === 'view' && tab.label !== view.title)
          resources.updateView(view.id, view.title)
      }
    }
    const focused = controller.context.view
    if (focused?.location === 'context')
      resources.selectTab(typeof focused.state.contextTabId === 'string' ? focused.state.contextTabId : focused.id)
  }))
  onScopeDispose(() => {
    pool.dispose()
    models.dispose()
    persistence.dispose()
    controller.registry.dispose()
  })
  async function flush() {
    const saved = await pool.flush()
    await persistence.flush()
    await inputs.flush().catch(options.onError)
    return saved
  }
  return { api, renderers, fileToolbarTargets, fileView, closeContextFiles, readingPositions, discardTask, prepareTaskDeletion, activeTask, backupError, controller, copies, models, pool, persistence, initialize, flush, openTask, newTask, startTaskWithSkill, openFile, dropResource, language, get initialized() {
    return initialized.value
  }, get navigationVersion() {
    return navigationVersion
  } }
}
