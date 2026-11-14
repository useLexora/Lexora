import type { EffectScope } from 'vue'
import type { TaskWorkspaceResource } from './taskResource'
import type { TaskCapability, UseTaskCapabilityOptions } from '@/modules/tasks'
import type { ResourceRef } from '@/workbench/common/workbench'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { effectScope, watch } from 'vue'
import { createUserQuestionInteractionState } from '@/modules/tasks'
import { resourceKey } from '@/workbench/common/workbench'
import { parseTaskResource, taskResource } from './taskResource'

export type TaskWorkspaceCreationOptions = Pick<UseTaskCapabilityOptions, 'initialTarget' | 'initialConversation' | 'questionInteraction'>

export interface TaskWorkspacePoolOptions {
  conversations: Pick<UseTaskCapabilityOptions['api']['localChat']['conversations'], 'get' | 'listBranches'>
  index: Pick<UseTaskCapabilityOptions['index']['data'], 'ensureConversation' | 'applyConversation'>
  createTask: (options: TaskWorkspaceCreationOptions) => TaskCapability
}

export interface TaskWorkspaceChange {
  readonly kind: 'ready' | 'released' | 'adopted'
  readonly resource: TaskWorkspaceResource
  readonly previous?: TaskWorkspaceResource
}

export class TaskWorkspacePool {
  readonly #questionInteraction = createUserQuestionInteractionState()
  readonly #changes = new Emitter<TaskWorkspaceChange>(() => console.error('TASK_WORKSPACE_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #options: TaskWorkspacePoolOptions
  readonly #entries = new Map<string, { task: TaskCapability, scope: EffectScope, ready: boolean, resource: TaskWorkspaceResource }>()
  readonly #leases = new Map<TaskCapability, number>()
  readonly #loading = new Map<string, Promise<TaskCapability>>()
  readonly #adopt: (previous: TaskWorkspaceResource, task: TaskCapability, resource: TaskWorkspaceResource) => void
  #disposed = false
  #retained: Set<string> | null = null

  constructor(options: TaskWorkspacePoolOptions, adopt: (previous: TaskWorkspaceResource, task: TaskCapability, resource: TaskWorkspaceResource) => void, readonly prepareLayout: () => Promise<void>) {
    this.#options = options
    this.#adopt = adopt
  }

  peek(resource: ResourceRef): TaskCapability | undefined {
    const entry = this.#entries.get(resourceKey(resource))
    return entry?.ready ? entry.task : undefined
  }

  open(resource: ResourceRef): Promise<TaskCapability> {
    const target = parseTaskResource(copyEventSnapshot(resource))
    if (!target)
      return Promise.reject(new Error('TASK_UNAVAILABLE'))
    const key = resourceKey(target)
    const pending = this.#loading.get(key)
    if (pending)
      return pending
    const existing = this.#entries.get(key)
    if (existing)
      return Promise.resolve(existing.task)
    const open: Promise<TaskCapability> = Promise.resolve().then(() => this.#load(target, () => this.#loading.get(key) === open)).finally(() => {
      if (this.#loading.get(key) === open)
        this.#loading.delete(key)
    })
    this.#loading.set(key, open)
    return open
  }

  async #load(resource: TaskWorkspaceResource, current: () => boolean): Promise<TaskCapability> {
    if (resource.scheme === 'draft')
      await this.prepareLayout()
    const conversation = resource.scheme === 'task' ? await this.#options.conversations.get(resource.id) : null
    if (!current() || (resource.scheme === 'task' && !conversation) || this.#disposed || conversation?.deletedAt || (this.#retained && !this.#retained.has(resourceKey(resource))))
      throw new Error('TASK_UNAVAILABLE')
    const requestedBranchId = resource.scheme === 'task' ? resource.data.branchId : undefined
    const branchId = requestedBranchId ?? conversation?.activeBranchId ?? null
    if (conversation && requestedBranchId !== undefined) {
      const branches = await this.#options.conversations.listBranches(conversation.id)
      if (!branches.some(branch => branch.id === branchId && branch.conversationId === conversation.id))
        throw new Error('TASK_BRANCH_UNAVAILABLE')
    }
    if (conversation) {
      await this.#options.index.ensureConversation(conversation.id)
      this.#options.index.applyConversation(conversation)
    }
    if (!current() || this.#disposed || (this.#retained && !this.#retained.has(resourceKey(resource))))
      throw new Error('TASK_UNAVAILABLE')
    const selectedResource = conversation && branchId
      ? taskResource(conversation.id, branchId)
      : resource
    const selectedKey = resourceKey(selectedResource)
    const existing = this.#entries.get(selectedKey)
    if (existing) {
      const shared = await (this.#loading.get(selectedKey) ?? Promise.resolve(existing.task))
      if (!current() || this.#disposed || !existing.ready || this.#entries.get(selectedKey)?.task !== shared)
        throw new Error('TASK_UNAVAILABLE')
      this.#adoptResource(resource, shared, selectedResource)
      return shared
    }
    const scope = effectScope(true)
    let currentResource = resource
    const task = scope.run(() => this.#options.createTask({
      questionInteraction: this.#questionInteraction,
      initialConversation: conversation,
      initialTarget: {
        draftKey: resource.scheme === 'draft' ? resource.id : undefined,
        conversationId: conversation?.id ?? null,
        branchId,
        spaceId: conversation?.spaceId ?? (resource.scheme === 'draft' ? resource.data.spaceId : null),
      },
    }))!
    const entry = { task, scope, ready: false, resource }
    this.#entries.set(resourceKey(resource), entry)
    try {
      await task.initialize()
      if (this.#disposed || this.#entries.get(resourceKey(currentResource))?.task !== task || !['ready', 'conflict'].includes(task.workspace.restoration.state.value))
        throw new Error('TASK_RESTORATION_FAILED')
      const concurrent = this.#entries.get(selectedKey)
      if (concurrent && concurrent !== entry) {
        const shared = await (this.#loading.get(selectedKey) ?? Promise.resolve(concurrent.task))
        if (!current() || this.#disposed || !concurrent.ready || this.#entries.get(selectedKey)?.task !== shared)
          throw new Error('TASK_UNAVAILABLE')
        this.#entries.delete(resourceKey(currentResource))
        task.dispose()
        scope.stop()
        this.#adoptResource(resource, shared, selectedResource)
        return shared
      }
      entry.ready = true
      const adoptSelection = () => {
        const id = task.workspace.session.activeConversationId.value
        const selectedBranch = task.workspace.session.activeBranchId.value
        if (!id || !selectedBranch || this.#disposed)
          return
        const next = taskResource(id, selectedBranch)
        if (resourceKey(currentResource) === resourceKey(next))
          return
        const previous = currentResource
        currentResource = next
        entry.resource = next
        this.#entries.delete(resourceKey(previous))
        this.#entries.set(resourceKey(next), entry)
        this.#adoptResource(previous, task, next)
      }
      scope.run(() => watch([task.workspace.session.activeConversationId, task.workspace.session.activeBranchId], adoptSelection))
      adoptSelection()
      this.#changes.fire(Object.freeze({ kind: 'ready', resource: currentResource }))
      return task
    }
    catch (error) {
      if (this.#entries.get(resourceKey(currentResource))?.task === task)
        this.#entries.delete(resourceKey(currentResource))
      task.dispose()
      scope.stop()
      throw error
    }
  }

  #adoptResource(previous: TaskWorkspaceResource, task: TaskCapability, next: TaskWorkspaceResource): void {
    if (resourceKey(previous) === resourceKey(next))
      return
    if (this.#retained?.delete(resourceKey(previous)))
      this.#retained.add(resourceKey(next))
    this.#adopt(previous, task, next)
    this.#changes.fire(Object.freeze({ kind: 'adopted', resource: next, previous }))
  }

  async flush(): Promise<boolean> {
    await Promise.allSettled(this.#loading.values())
    const results = await Promise.all([...this.#entries.values()].map(entry => entry.task.flushDrafts()))
    return results.every(Boolean)
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.#entries.values()].map(entry => entry.task.refreshRuntimeDependentState()))
  }

  acquire(resource: ResourceRef): () => void {
    const task = this.peek(resource)
    if (!task || this.#disposed)
      throw new Error('TASK_UNAVAILABLE')
    this.#leases.set(task, (this.#leases.get(task) ?? 0) + 1)
    let active = true
    return () => {
      if (!active)
        return
      active = false
      const remaining = (this.#leases.get(task) ?? 1) - 1
      if (remaining)
        this.#leases.set(task, remaining)
      else this.#leases.delete(task)
      this.#releaseUnused()
    }
  }

  retain(resources: ResourceRef[]): void {
    const keys = new Set(resources.map(resourceKey))
    this.#retained = keys
    for (const key of this.#loading.keys()) {
      if (!keys.has(key))
        this.#loading.delete(key)
    }
    this.#releaseUnused()
  }

  #releaseUnused(): void {
    if (!this.#retained)
      return
    const failures: unknown[] = []
    for (const [key, entry] of this.#entries) {
      if (this.#retained.has(key) || (!this.#disposed && this.#leases.has(entry.task)))
        continue
      this.#entries.delete(key)
      for (const release of [() => entry.task.dispose(), () => entry.scope.stop()]) {
        try {
          release()
        }
        catch (error) { failures.push(error) }
      }
      this.#changes.fire(Object.freeze({ kind: 'released', resource: copyEventSnapshot(entry.resource) }))
    }
    if (failures.length)
      throw new AggregateError(failures, 'TASK_WORKSPACE_RELEASE_FAILED')
  }

  dispose(): void {
    this.#disposed = true
    this.#leases.clear()
    try {
      this.retain([])
    }
    finally { this.#changes.dispose() }
  }
}
