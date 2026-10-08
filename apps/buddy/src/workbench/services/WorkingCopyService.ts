import type { Event, ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { EventSnapshot } from '@buddy-shared/events/eventTypes'
import type { WorkbenchState } from '@buddy-shared/workbench/workbenchState'
import type { ResourceRef } from '../common/workbench'
import { Emitter, filterEvent } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'
import { ReadonlyMapView } from '@buddy-shared/events/ReadonlyMapView'
import { resourceKey } from '../common/workbench'

export interface TextDocument { text: string, etag: string }

interface WorkingCopyState {
  key: string
  resource: ResourceRef
  incarnation: string
  revision: number
  contentVersion: number
  savedVersion: number
  text: string
  baseText: string
  etag: string
  dirty: boolean
  loading: boolean
  saving: boolean
  blocked?: boolean
  error: string | null
  conflict: TextDocument | null
}

export type WorkingCopy = EventSnapshot<WorkingCopyState>
export type WorkingCopyIdentity = Pick<WorkingCopy, 'key' | 'incarnation' | 'contentVersion'>
export type WorkingCopyChangeKind = 'registered' | 'restored' | 'released' | 'load-started' | 'loaded' | 'load-failed' | 'edited' | 'save-started' | 'saved' | 'save-conflict' | 'save-failed' | 'conflict-resolved' | 'discarded' | 'access-changed'
export interface WorkingCopyChange {
  readonly kind: WorkingCopyChangeKind
  readonly revision: number
  readonly copy: WorkingCopy
  readonly previous: WorkingCopy | null
  readonly operationId?: string
  readonly savedVersion?: number
}

interface SaveState {
  readonly key: string
  readonly incarnation: string
  readonly currentVersion: number
  readonly dirtyAfter: boolean
}
export type WorkingCopySaveResult
  = | (SaveState & { readonly status: 'saved', readonly operationId: string, readonly savedVersion: number, readonly etag: string })
    | (SaveState & { readonly status: 'unchanged' })
    | (SaveState & { readonly status: 'conflict', readonly operationId?: string })
    | (SaveState & { readonly status: 'failed', readonly operationId: string, readonly error: 'FILE_SAVE_FAILED' })
    | { readonly status: 'unavailable', readonly key: string, readonly reason: 'missing' | 'loading' | 'no-etag' | 'disposed' | 'blocked' }

export interface WorkingCopyProvider {
  canAccess?: (resource: ResourceRef) => boolean
  read: (resource: ResourceRef) => Promise<TextDocument>
  save: (resource: ResourceRef, document: TextDocument) => Promise<{ status: 'saved' | 'conflict', document: TextDocument }>
}

export class WorkingCopyService {
  readonly #copies = new Map<string, WorkingCopy>()
  readonly copies = new ReadonlyMapView(this.#copies)
  readonly #provider: WorkingCopyProvider
  readonly #changes: Emitter<WorkingCopyChange>
  readonly #loading = new Map<string, Promise<WorkingCopy>>()
  readonly #saving = new Map<string, Promise<WorkingCopySaveResult>>()
  readonly #mutations = new Set<(resource: ResourceRef) => boolean>()
  #revision = 0
  #stopped = false
  #disposing: Promise<void> | undefined

  constructor(provider: WorkingCopyProvider, onListenerError: ListenerErrorHandler = () => console.error('WORKING_COPY_OBSERVER_FAILED')) {
    this.#provider = provider
    this.#changes = new Emitter(onListenerError)
  }

  readonly onDidChange: Event<WorkingCopyChange> = (listener, options) => this.#changes.event(listener, options)
  readonly onDidRegister = filterEvent(this.onDidChange, event => event.previous === null)
  readonly onDidRelease = filterEvent(this.onDidChange, event => event.kind === 'released')
  readonly onDidRestore = filterEvent(this.onDidChange, event => event.kind === 'restored')
  readonly onDidChangeContent = filterEvent(this.onDidChange, event => event.kind === 'restored' || (event.kind !== 'released' && event.previous !== null && event.copy.contentVersion !== event.previous.contentVersion))
  readonly onDidChangeDirty = filterEvent(this.onDidChange, event => event.kind !== 'released' && event.copy.dirty !== (event.previous?.dirty ?? false))
  readonly onDidChangeConflict = filterEvent(this.onDidChange, event => event.kind !== 'released' && (event.copy.conflict?.etag !== event.previous?.conflict?.etag || event.copy.conflict?.text !== event.previous?.conflict?.text))
  readonly onDidStartLoading = filterEvent(this.onDidChange, event => event.kind === 'load-started')
  readonly onDidLoad = filterEvent(this.onDidChange, event => event.kind === 'loaded' || event.kind === 'load-failed')
  readonly onDidStartSaving = filterEvent(this.onDidChange, event => event.kind === 'save-started')
  readonly onDidSave = filterEvent(this.onDidChange, event => event.kind === 'saved')
  readonly onDidFailSave = filterEvent(this.onDidChange, event => event.kind === 'save-conflict' || event.kind === 'save-failed')

  get revision(): number { return this.#revision }

  onDidChangeResource(resource: ResourceRef): Event<WorkingCopyChange> {
    const key = resourceKey(resource)
    return filterEvent(this.onDidChange, event => event.copy.key === key)
  }

  get(resource: ResourceRef): WorkingCopy | undefined {
    return this.#copies.get(resourceKey(resource))
  }

  isCurrent(identity: WorkingCopyIdentity): boolean {
    const copy = this.#copies.get(identity.key)
    return copy?.incarnation === identity.incarnation && copy.contentVersion === identity.contentVersion
  }

  dirty(resource: ResourceRef): boolean {
    return this.get(resource)?.dirty ?? false
  }

  canAccess(resource: ResourceRef): boolean {
    return this.#provider.canAccess?.(resource) !== false && ![...this.#mutations].some(matches => matches(resource))
  }

  // A bounded lease freezes editor entry points while a filesystem operation is pending.
  // Only its owner may save or retire copies; failure leaves their content untouched.
  beginMutation(matches: (resource: ResourceRef) => boolean) {
    const affected = [...this.#copies.values()].filter(copy => matches(copy.resource))
    if (this.#stopped || affected.some(copy => copy.loading || copy.saving || copy.blocked))
      return null
    this.#mutations.add(matches)
    for (const copy of affected)
      this.#commit('access-changed', { ...copy, blocked: true })
    let active = true
    const check = (resource: ResourceRef) => {
      if (!active || !matches(resource))
        throw new Error('WORKING_COPY_MUTATION_EXPIRED')
    }
    const remove = (resource: ResourceRef) => {
      check(resource)
      const copy = this.get(resource)
      if (!copy)
        return
      this.#copies.delete(copy.key)
      const revision = ++this.#revision
      this.#changes.fire(copyEventSnapshot({ kind: 'released', revision, copy: { ...copy, revision }, previous: copy }))
    }
    return {
      save: (resource: ResourceRef) => {
        check(resource)
        return this.#saveResource(resource, true)
      },
      relocate: (moves: readonly { from: ResourceRef, to: ResourceRef }[]) => {
        for (const { from, to } of moves) {
          check(from)
          check(to)
          if (this.get(to))
            throw new Error('WORKING_COPY_DESTINATION_OCCUPIED')
        }
        for (const { from, to } of moves) {
          const copy = this.get(from)
          if (!copy)
            continue
          this.#commit('restored', { ...copy, key: resourceKey(to), resource: to, incarnation: crypto.randomUUID() })
          remove(from)
        }
      },
      remove,
      release: () => {
        if (!active)
          return
        active = false
        this.#mutations.delete(matches)
        for (const copy of [...this.#copies.values()].filter(copy => matches(copy.resource)))
          this.#commit('access-changed', { ...copy, blocked: [...this.#mutations].some(other => other(copy.resource)) })
      },
    }
  }

  open(resource: ResourceRef): Promise<WorkingCopy> {
    if (this.#stopped)
      return Promise.reject(new Error('WORKING_COPY_DISPOSED'))
    if (!this.canAccess(resource))
      return Promise.reject(new Error('WORKING_COPY_BLOCKED'))
    const key = resourceKey(resource)
    const pending = this.#loading.get(key)
    if (pending)
      return pending
    let copy = this.#copies.get(key)
    if (copy && !copy.loading && !copy.error)
      return Promise.resolve(copy)
    const operationId = crypto.randomUUID()
    let finish!: (copy: WorkingCopy) => void
    const promise = new Promise<WorkingCopy>(resolve => finish = resolve)
    this.#loading.set(key, promise)
    if (!copy) {
      copy = this.#commit('registered', {
        key,
        resource,
        incarnation: crypto.randomUUID(),
        revision: 0,
        contentVersion: 0,
        savedVersion: 0,
        text: '',
        baseText: '',
        etag: '',
        dirty: false,
        loading: true,
        saving: false,
        error: null,
        conflict: null,
      })
    }
    const current = this.#copies.get(key)
    if (this.#stopped || current?.incarnation !== copy.incarnation) {
      finish(copyEventSnapshot({ ...copy, loading: false, error: 'WORKING_COPY_RELEASED' }))
      if (this.#loading.get(key) === promise)
        this.#loading.delete(key)
      return promise
    }
    copy = this.#commit('load-started', { ...current, loading: true, error: null }, { operationId })
    void this.#load(copy, operationId, promise).then(finish)
    return promise
  }

  edit(resource: ResourceRef, text: string): void {
    const copy = this.get(resource)
    if (this.#stopped || !copy || copy.text === text || !this.canAccess(resource))
      return
    this.#commit('edited', { ...copy, text, contentVersion: copy.contentVersion + 1 })
  }

  save(resource: ResourceRef): Promise<WorkingCopySaveResult> {
    return this.#saveResource(resource)
  }

  #saveResource(resource: ResourceRef, mutation = false): Promise<WorkingCopySaveResult> {
    const key = resourceKey(resource)
    if (this.#stopped)
      return Promise.resolve({ status: 'unavailable', key, reason: 'disposed' })
    if (!mutation && !this.canAccess(resource))
      return Promise.resolve({ status: 'unavailable', key, reason: 'blocked' })
    const pending = this.#saving.get(key)
    if (pending)
      return pending
    const copy = this.get(resource)
    if (!copy || copy.loading || !copy.etag)
      return Promise.resolve({ status: 'unavailable', key, reason: !copy ? 'missing' : copy.loading ? 'loading' : 'no-etag' })
    if (copy.conflict)
      return Promise.resolve(copyEventSnapshot({ status: 'conflict', ...this.#saveState(copy) }))
    if (!copy.dirty)
      return Promise.resolve(copyEventSnapshot({ status: 'unchanged', ...this.#saveState(copy) }))
    const operationId = crypto.randomUUID()
    let finish!: (result: WorkingCopySaveResult) => void
    const promise = new Promise<WorkingCopySaveResult>(resolve => finish = resolve)
    this.#saving.set(key, promise)
    this.#commit('save-started', { ...copy, saving: true, error: null }, { operationId })
    void this.#save(copy, operationId, promise).then(finish)
    return promise
  }

  resolveConflict(resource: ResourceRef, choice: 'disk' | 'local'): void {
    const copy = this.get(resource)
    if (this.#stopped || !copy?.conflict || copy.saving || !this.canAccess(resource))
      return
    const text = choice === 'disk' ? copy.conflict.text : copy.text
    this.#commit('conflict-resolved', {
      ...copy,
      text,
      baseText: copy.conflict.text,
      etag: copy.conflict.etag,
      contentVersion: copy.contentVersion + Number(text !== copy.text),
      conflict: null,
      error: null,
    })
  }

  discard(resource: ResourceRef): void {
    const copy = this.get(resource)
    if (this.#stopped || !copy || copy.saving || !this.canAccess(resource) || (!copy.dirty && !copy.conflict && !copy.error))
      return
    this.#commit('discarded', { ...copy, text: copy.baseText, contentVersion: copy.contentVersion + Number(copy.text !== copy.baseText), conflict: null, error: null })
  }

  release(resource: ResourceRef): boolean {
    const key = resourceKey(resource)
    const copy = this.#copies.get(key)
    if (!copy)
      return true
    if (copy.dirty || copy.saving || copy.blocked)
      return false
    this.#copies.delete(key)
    this.#loading.delete(key)
    const revision = ++this.#revision
    this.#changes.fire(copyEventSnapshot({ kind: 'released', revision, copy: { ...copy, revision }, previous: copy }))
    return true
  }

  restore(backups: WorkbenchState['backups']): void {
    if (this.#stopped)
      return
    for (const backup of backups) {
      const resource = backup.resource as ResourceRef | null
      if (!resource || typeof resource.scheme !== 'string' || typeof resource.id !== 'string' || !resource.data || resourceKey(resource) !== backup.key || this.#copies.has(backup.key))
        continue
      this.#commit('restored', {
        key: backup.key,
        resource,
        incarnation: crypto.randomUUID(),
        revision: 0,
        contentVersion: 1,
        savedVersion: 0,
        text: backup.text,
        baseText: backup.baseText,
        etag: backup.etag,
        dirty: backup.text !== backup.baseText,
        loading: true,
        saving: false,
        error: null,
        conflict: null,
      })
    }
  }

  backups(): WorkbenchState['backups'] {
    return [...this.#copies.values()].filter(copy => copy.dirty).map(copy => ({
      key: copy.key,
      resource: JSON.parse(JSON.stringify(copy.resource)),
      text: copy.text,
      baseText: copy.baseText,
      etag: copy.etag,
      savedAt: new Date().toISOString(),
    }))
  }

  async whenIdle(): Promise<void> {
    while (this.#saving.size)
      await Promise.all(this.#saving.values())
  }

  stop(): Promise<void> {
    this.#stopped = true
    return this.whenIdle()
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.stop().then(() => this.#changes.dispose())
    return this.#disposing
  }

  async #load(started: WorkingCopy, operationId: string, promise: Promise<WorkingCopy>): Promise<WorkingCopy> {
    try {
      const document = await this.#provider.read(started.resource)
      const current = this.#copies.get(started.key)
      if (this.#stopped || current?.incarnation !== started.incarnation)
        return copyEventSnapshot({ ...started, loading: false, error: 'WORKING_COPY_RELEASED' })
      this.#loading.delete(started.key)
      if (current.dirty && current.etag)
        return this.#commit('loaded', { ...current, loading: false, conflict: document.etag !== current.etag ? document : null }, { operationId })
      const text = current.dirty ? current.text : document.text
      const contentVersion = current.contentVersion + Number(text !== current.text)
      return this.#commit('loaded', { ...current, text, contentVersion, savedVersion: text === document.text ? contentVersion : current.savedVersion, baseText: document.text, etag: document.etag, loading: false, conflict: null }, { operationId })
    }
    catch {
      const current = this.#copies.get(started.key)
      if (this.#stopped || current?.incarnation !== started.incarnation)
        return copyEventSnapshot({ ...started, loading: false, error: 'WORKING_COPY_RELEASED' })
      this.#loading.delete(started.key)
      return this.#commit('load-failed', { ...current, loading: false, error: 'FILE_READ_FAILED' }, { operationId })
    }
    finally {
      if (this.#loading.get(started.key) === promise)
        this.#loading.delete(started.key)
    }
  }

  async #save(started: WorkingCopy, operationId: string, promise: Promise<WorkingCopySaveResult>): Promise<WorkingCopySaveResult> {
    try {
      const result = await this.#provider.save(started.resource, { text: started.text, etag: started.etag })
      const current = this.#copies.get(started.key)!
      this.#saving.delete(started.key)
      if (result.status === 'conflict') {
        const copy = this.#commit('save-conflict', { ...current, saving: false, conflict: result.document }, { operationId })
        return copyEventSnapshot({ status: 'conflict', operationId, ...this.#saveState(copy) })
      }
      const copy = this.#commit('saved', { ...current, saving: false, baseText: started.text, etag: result.document.etag, savedVersion: started.contentVersion }, { operationId, savedVersion: started.contentVersion })
      return copyEventSnapshot({ status: 'saved', operationId, savedVersion: started.contentVersion, etag: copy.etag, ...this.#saveState(copy) })
    }
    catch {
      const current = this.#copies.get(started.key)!
      this.#saving.delete(started.key)
      const copy = this.#commit('save-failed', { ...current, saving: false, error: 'FILE_SAVE_FAILED' }, { operationId })
      return copyEventSnapshot({ status: 'failed', operationId, error: 'FILE_SAVE_FAILED', ...this.#saveState(copy) })
    }
    finally {
      if (this.#saving.get(started.key) === promise)
        this.#saving.delete(started.key)
    }
  }

  #saveState(copy: WorkingCopy): SaveState {
    return { key: copy.key, incarnation: copy.incarnation, currentVersion: copy.contentVersion, dirtyAfter: copy.dirty }
  }

  #commit(kind: WorkingCopyChangeKind, state: WorkingCopyState | WorkingCopy, detail: { operationId?: string, savedVersion?: number } = {}): WorkingCopy {
    const previous = this.#copies.get(state.key) ?? null
    const revision = ++this.#revision
    const copy = copyEventSnapshot({ ...state, revision, dirty: state.text !== state.baseText })
    this.#copies.set(copy.key, copy)
    this.#changes.fire(copyEventSnapshot({ kind, revision, copy, previous, ...detail }))
    return copy
  }
}
