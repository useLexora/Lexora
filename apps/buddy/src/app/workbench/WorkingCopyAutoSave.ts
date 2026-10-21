import type { FileAutoSaveController, FileAutoSaveStatus } from '@/workbench/common/fileAutoSave'
import type { ResourceRef } from '@/workbench/common/workbench'
import type { ConfigurationService } from '@/workbench/services/ConfigurationService'
import type { ViewCloseDecision } from '@/workbench/services/WorkbenchController'
import type { WorkingCopy, WorkingCopyChange, WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { Emitter } from '@buddy-shared/events/Emitter'
import { useDebounceFn } from '@vueuse/core'
import { resourceKey } from '@/workbench/common/workbench'

type SaveTask = ReturnType<typeof useDebounceFn<() => Promise<void>>>
interface Entry {
  resource: ResourceRef
  incarnation: string
  task: SaveTask
  editedAt: number
  savingVersion: number
  recovered: boolean
  failed: boolean
  pauses: Set<symbol>
}

/** Adapts existing debounce and working-copy saves; never owns file contents or writes. */
export class WorkingCopyAutoSave implements FileAutoSaveController {
  readonly #entries = new Map<string, Entry>()
  readonly #changes = new Emitter<void>(() => console.error('AUTO_SAVE_OBSERVER_FAILED'))
  readonly #subscriptions: (() => void)[]
  #started = false
  #disposed = false

  constructor(readonly copies: WorkingCopyService, readonly configuration: ConfigurationService) {
    for (const copy of copies.copies.values()) this.#entry(copy).recovered = copy.dirty
    this.#subscriptions = [
      copies.onDidChange(event => this.#changed(event)).dispose,
      configuration.onDidChangeEffective((event) => {
        if (!event.keys.includes('files.autoSave'))
          return
        for (const entry of this.#entries.values()) {
          entry.task.cancel()
          entry.editedAt = Date.now()
          this.#reconcile(entry)
        }
        this.#changes.fire()
      }).dispose,
    ]
  }

  get enabled(): boolean { return this.configuration.get('files.autoSave') === 'afterDelay' }

  setEnabled(enabled: boolean): void {
    if (!this.#disposed)
      this.configuration.set('files.autoSave', enabled ? 'afterDelay' : 'off')
  }

  subscribe(listener: () => void): () => void { return this.#changes.event(listener).dispose }

  start(): void {
    if (this.#disposed || this.#started)
      return
    this.#started = true
    for (const entry of this.#entries.values()) this.#reconcile(entry)
    this.#changes.fire()
  }

  status(resource: ResourceRef): FileAutoSaveStatus {
    const copy = this.copies.get(resource)
    if (!copy)
      return 'loading'
    const entry = this.#entries.get(copy.incarnation)
    if (copy.saving)
      return copy.contentVersion > (entry?.savingVersion ?? copy.contentVersion) ? 'saving-dirty' : 'saving'
    if (copy.conflict)
      return 'conflict'
    if (entry?.failed || copy.error === 'FILE_SAVE_FAILED')
      return 'failed'
    if (entry?.recovered && copy.dirty)
      return 'recovered'
    if (copy.blocked)
      return 'blocked'
    if (entry?.pauses.size)
      return 'paused'
    if (copy.loading || !copy.etag)
      return 'loading'
    if (!this.enabled)
      return 'off'
    return entry?.task.isPending.value ? 'waiting' : 'idle'
  }

  /** A close plan holds this pause until it is cancelled or its cleanup completes. */
  pause(resource: ResourceRef): () => void {
    const copy = this.copies.get(resource)
    if (!copy || this.#disposed)
      return () => {}
    const entry = this.#entry(copy)
    const token = Symbol('close')
    entry.pauses.add(token)
    entry.task.cancel()
    this.#changes.fire()
    return () => {
      if (!entry.pauses.delete(token) || this.#disposed)
        return
      entry.editedAt = Date.now()
      this.#reconcile(entry)
      this.#changes.fire()
    }
  }

  async prepareClose(resource: ResourceRef, prepare: () => Promise<ViewCloseDecision>): Promise<ViewCloseDecision> {
    const resume = this.pause(resource)
    try {
      await this.copies.settle(value => resourceKey(value) === resourceKey(resource))
      const decision = await prepare()
      if (!decision) {
        resume()
        return false
      }
      const plan = decision === true ? {} : decision
      return {
        ...plan,
        cancel: () => {
          try {
            plan.cancel?.()
          }
          finally {
            resume()
          }
        },
        complete: async (commit) => {
          try {
            await plan.complete?.(commit)
          }
          finally {
            resume()
          }
        },
      }
    }
    catch (error) {
      resume()
      throw error
    }
  }

  /** Explicit user action can resume recovered/failed content, never bypass guards. */
  async retry(resource: ResourceRef): Promise<void> {
    const copy = this.copies.get(resource)
    if (!copy || this.#disposed || !this.#started)
      return
    const entry = this.#entry(copy)
    if (copy.loading || copy.saving || copy.blocked || copy.conflict || !copy.etag || entry.pauses.size || (copy.error && copy.error !== 'FILE_SAVE_FAILED'))
      return
    entry.task.cancel()
    entry.recovered = false
    entry.failed = false
    await this.#save(entry, true)
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    this.#subscriptions.forEach(stop => stop())
    for (const entry of this.#entries.values()) entry.task.cancel()
    this.#entries.clear()
    this.#changes.dispose()
  }

  #entry(copy: WorkingCopy): Entry {
    let entry = this.#entries.get(copy.incarnation)
    if (!entry) {
      const held: Entry = {
        resource: copy.resource,
        incarnation: copy.incarnation,
        task: undefined!,
        editedAt: Date.now(),
        savingVersion: copy.contentVersion,
        recovered: false,
        failed: false,
        pauses: new Set(),
      }
      held.task = useDebounceFn(() => this.#save(held), () => Math.max(0, 1000 - (Date.now() - held.editedAt)))
      this.#entries.set(copy.incarnation, held)
      entry = held
    }
    return entry
  }

  #current(entry: Entry): WorkingCopy | undefined {
    if (this.#disposed || this.#entries.get(entry.incarnation) !== entry)
      return
    const copy = this.copies.get(entry.resource)
    return copy?.incarnation === entry.incarnation ? copy : undefined
  }

  #changed(event: WorkingCopyChange): void {
    if (this.#disposed || event.copy.resource.scheme !== 'file')
      return
    const entry = this.#entry(event.copy)
    if (event.kind === 'released') {
      entry.task.cancel()
      this.#entries.delete(entry.incarnation)
    }
    else {
      entry.resource = event.copy.resource
      if (event.kind === 'restored')
        entry.recovered = event.copy.dirty
      if (event.kind === 'save-started')
        entry.savingVersion = event.copy.contentVersion
      if (event.kind === 'save-failed')
        entry.failed = true
      if (event.kind === 'saved' || event.kind === 'conflict-resolved')
        entry.failed = false
      if (event.kind === 'edited' || event.kind === 'moved' || (event.kind === 'guarded' && !event.copy.blocked)) {
        entry.task.cancel()
        entry.editedAt = Date.now()
      }
      if (!event.copy.dirty || event.kind === 'discarded') {
        entry.recovered = false
        entry.failed = false
      }
      this.#reconcile(entry)
    }
    this.#changes.fire()
  }

  #reconcile(entry: Entry): void {
    const copy = this.#current(entry)
    if (!copy || copy.resource.scheme !== 'file' || !this.#started || !this.enabled || !copy.dirty || copy.loading || !copy.etag || copy.blocked || copy.error || copy.conflict || entry.failed || entry.recovered || entry.pauses.size) {
      entry.task.cancel()
      return
    }
    // Edits during an in-flight save retain their own deadline. The saved event
    // rechecks dirty state even when their debounce already expired meanwhile.
    if (!copy.saving && !entry.task.isPending.value)
      void entry.task().catch(() => this.#fail(entry))
    else if (copy.saving && !entry.task.isPending.value && Date.now() - entry.editedAt < 1000)
      void entry.task().catch(() => this.#fail(entry))
  }

  async #save(entry: Entry, explicit = false): Promise<void> {
    const copy = this.#current(entry)
    if (!copy || !this.#started || (!explicit && !this.enabled) || !copy.dirty || copy.loading || copy.saving || !copy.etag || copy.blocked || copy.conflict || entry.pauses.size || (!explicit && (copy.error || entry.failed || entry.recovered))) {
      if (!this.#disposed)
        this.#changes.fire()
      return
    }
    try {
      const result = await this.copies.save(copy.resource)
      if (!this.#current(entry))
        return
      switch (result.status) {
        case 'failed':
          if (this.#current(entry)?.error === 'FILE_SAVE_FAILED')
            this.#fail(entry)
          break
        case 'saved':
        case 'unchanged':
          this.#reconcile(entry)
          break
        case 'conflict':
        case 'unavailable':
          // State events cancel invalid tasks. Do not cancel a newer task that
          // may have been scheduled since this request completed.
          break
      }
    }
    catch {
      this.#fail(entry)
    }
    finally {
      if (!this.#disposed)
        this.#changes.fire()
    }
  }

  #fail(entry: Entry): void {
    const copy = this.#current(entry)
    if (!copy?.dirty || copy.saving)
      return
    entry.failed = true
    entry.task.cancel()
    this.#changes.fire()
  }
}
