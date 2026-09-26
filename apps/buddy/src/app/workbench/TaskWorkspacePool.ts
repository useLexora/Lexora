import type { EffectScope } from 'vue'
import type { TaskCapability, UseTaskCapabilityOptions } from '@/modules/tasks'
import type { ResourceRef } from '@/workbench/common/workbench'
import { effectScope } from 'vue'
import { useTaskCapability } from '@/modules/tasks'
import { resourceKey } from '@/workbench/common/workbench'

export class TaskWorkspacePool {
  readonly #options: Omit<UseTaskCapabilityOptions, 'initialTarget'>
  readonly #entries = new Map<string, { task: TaskCapability, scope: EffectScope }>()
  readonly #loading = new Map<string, Promise<TaskCapability>>()
  readonly #adopt: (previous: ResourceRef, task: TaskCapability, id: string) => void
  #disposed = false
  #retained: Set<string> | null = null

  constructor(options: Omit<UseTaskCapabilityOptions, 'initialTarget'>, adopt: (previous: ResourceRef, task: TaskCapability, id: string) => void, readonly prepareLayout: () => Promise<void>) {
    this.#options = options
    this.#adopt = adopt
  }

  peek(resource: ResourceRef): TaskCapability | undefined {
    return this.#entries.get(resourceKey(resource))?.task
  }

  open(resource: ResourceRef): Promise<TaskCapability> {
    const key = resourceKey(resource)
    const pending = this.#loading.get(key)
    if (pending)
      return pending
    const existing = this.#entries.get(key)
    if (existing)
      return Promise.resolve(existing.task)
    const open: Promise<TaskCapability> = Promise.resolve().then(() => this.#load(resource, () => this.#loading.get(key) === open)).finally(() => {
      if (this.#loading.get(key) === open)
        this.#loading.delete(key)
    })
    this.#loading.set(key, open)
    return open
  }

  async #load(resource: ResourceRef, current: () => boolean): Promise<TaskCapability> {
    if (resource.scheme === 'draft')
      await this.prepareLayout()
    const conversation = resource.scheme === 'task' ? await this.#options.api.localChat.conversations.get(resource.id) : null
    if (!current() || (resource.scheme === 'task' && !conversation) || this.#disposed || conversation?.deletedAt || (this.#retained && !this.#retained.has(resourceKey(resource))))
      throw new Error('TASK_UNAVAILABLE')
    if (conversation) {
      if (!this.#options.index.data.conversations.value.some(item => item.id === conversation.id))
        await this.#options.index.data.refreshConversations()
      this.#options.index.data.applyConversation(conversation)
    }
    if (!current() || this.#disposed || (this.#retained && !this.#retained.has(resourceKey(resource))))
      throw new Error('TASK_UNAVAILABLE')
    const scope = effectScope(true)
    let currentResource = resource
    const task = scope.run(() => useTaskCapability({
      ...this.#options,
      initialTarget: {
        draftKey: resource.scheme === 'draft' ? resource.id : undefined,
        conversationId: conversation?.id ?? null,
        branchId: conversation?.activeBranchId ?? null,
        spaceId: conversation?.spaceId ?? (typeof resource.data.spaceId === 'string' ? resource.data.spaceId : null),
      },
      onDraftCommitted: (draftId, id) => {
        const previous = currentResource
        currentResource = { scheme: 'task', id, data: {} }
        this.#entries.delete(resourceKey(previous))
        this.#entries.set(resourceKey(currentResource), { task, scope })
        this.#options.onDraftCommitted?.(draftId, id)
        this.#adopt(previous, task, id)
      },
    }))!
    this.#entries.set(resourceKey(resource), { task, scope })
    try {
      await task.initialize()
      if (this.#disposed || this.#entries.get(resourceKey(currentResource))?.task !== task || task.workspace.restoration.state.value !== 'ready')
        throw new Error('TASK_RESTORATION_FAILED')
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

  async flush(): Promise<boolean> {
    await Promise.allSettled(this.#loading.values())
    const results = await Promise.all([...this.#entries.values()].map(entry => entry.task.flushDrafts()))
    return results.every(Boolean)
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.#entries.values()].map(entry => entry.task.refreshRuntimeDependentState()))
  }

  retain(resources: ResourceRef[]): void {
    const keys = new Set(resources.map(resourceKey))
    this.#retained = keys
    for (const key of this.#loading.keys()) {
      if (!keys.has(key))
        this.#loading.delete(key)
    }
    for (const [key, entry] of this.#entries) {
      if (keys.has(key))
        continue
      entry.task.dispose()
      entry.scope.stop()
      this.#entries.delete(key)
    }
  }

  dispose(): void {
    this.#disposed = true
    this.retain([])
  }
}
