import type { WorkbenchState } from '@buddy-shared/workbench/workbenchState'
import type { ResourceRef } from '../common/workbench'
import { resourceKey } from '../common/workbench'

export interface TextDocument { text: string, etag: string }
export interface WorkingCopy {
  resource: ResourceRef
  text: string
  baseText: string
  etag: string
  loading: boolean
  saving: boolean
  error: string | null
  conflict: TextDocument | null
}
export interface WorkingCopyProvider {
  read: (resource: ResourceRef) => Promise<TextDocument>
  save: (resource: ResourceRef, document: TextDocument) => Promise<{ status: 'saved' | 'conflict', document: TextDocument }>
}

export class WorkingCopyService {
  readonly copies = new Map<string, WorkingCopy>()
  readonly #provider: WorkingCopyProvider
  readonly #listeners = new Set<() => void>()
  readonly #loading = new Map<string, Promise<WorkingCopy>>()
  readonly #saving = new Map<string, Promise<boolean>>()

  constructor(provider: WorkingCopyProvider) {
    this.#provider = provider
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get(resource: ResourceRef): WorkingCopy | undefined {
    return this.copies.get(resourceKey(resource))
  }

  dirty(resource: ResourceRef): boolean {
    const copy = this.get(resource)
    return !!copy && copy.text !== copy.baseText
  }

  open(resource: ResourceRef): Promise<WorkingCopy> {
    const key = resourceKey(resource)
    const pending = this.#loading.get(key)
    if (pending)
      return pending
    const existing = this.copies.get(key)
    if (existing && !existing.loading && !existing.error)
      return Promise.resolve(existing)
    const copy: WorkingCopy = existing ?? { resource, text: '', baseText: '', etag: '', loading: true, saving: false, error: null, conflict: null }
    copy.loading = true
    copy.error = null
    this.copies.set(key, copy)
    const open = this.#provider.read(resource).then((document) => {
      if (copy.etag && copy.text !== copy.baseText) {
        copy.conflict = document.etag !== copy.etag ? document : null
      }
      else {
        copy.text = document.text
        copy.baseText = document.text
        copy.etag = document.etag
      }
      return copy
    }).catch((error: unknown) => {
      copy.error = error instanceof Error ? error.message : 'FILE_READ_FAILED'
      return copy
    }).finally(() => {
      copy.loading = false
      this.#loading.delete(key)
      this.#changed()
    })
    this.#loading.set(key, open)
    this.#changed()
    return open
  }

  edit(resource: ResourceRef, text: string): void {
    const copy = this.get(resource)
    if (!copy || copy.text === text)
      return
    copy.text = text
    this.#changed()
  }

  save(resource: ResourceRef): Promise<boolean> {
    const key = resourceKey(resource)
    const pending = this.#saving.get(key)
    if (pending)
      return pending
    const copy = this.get(resource)
    if (!copy || copy.loading || !copy.etag || copy.conflict)
      return Promise.resolve(false)
    if (!this.dirty(resource))
      return Promise.resolve(true)
    const snapshot = { text: copy.text, etag: copy.etag }
    copy.saving = true
    copy.error = null
    const save = this.#provider.save(resource, snapshot).then((result) => {
      if (result.status === 'conflict') {
        copy.conflict = result.document
        return false
      }
      copy.baseText = snapshot.text
      copy.etag = result.document.etag
      return !this.dirty(resource)
    }).catch((error: unknown) => {
      copy.error = error instanceof Error ? error.message : 'FILE_SAVE_FAILED'
      return false
    }).finally(() => {
      copy.saving = false
      this.#saving.delete(key)
      this.#changed()
    })
    this.#saving.set(key, save)
    this.#changed()
    return save
  }

  resolveConflict(resource: ResourceRef, choice: 'disk' | 'local'): void {
    const copy = this.get(resource)
    if (!copy?.conflict || copy.saving)
      return
    if (choice === 'disk')
      copy.text = copy.conflict.text
    copy.baseText = copy.conflict.text
    copy.etag = copy.conflict.etag
    copy.conflict = null
    copy.error = null
    this.#changed()
  }

  discard(resource: ResourceRef): void {
    const copy = this.get(resource)
    if (!copy || copy.saving)
      return
    copy.text = copy.baseText
    copy.conflict = null
    copy.error = null
    this.#changed()
  }

  release(resource: ResourceRef): void {
    const key = resourceKey(resource)
    if (!this.dirty(resource) && !this.#loading.has(key) && !this.#saving.has(key))
      this.copies.delete(key)
  }

  restore(backups: WorkbenchState['backups']): void {
    for (const backup of backups) {
      const resource = backup.resource as ResourceRef | null
      if (!resource || typeof resource.scheme !== 'string' || typeof resource.id !== 'string' || !resource.data || resourceKey(resource) !== backup.key)
        continue
      this.copies.set(backup.key, { resource, text: backup.text, baseText: backup.baseText, etag: backup.etag, loading: true, saving: false, error: null, conflict: null })
    }
    this.#changed()
  }

  backups(): WorkbenchState['backups'] {
    return [...this.copies.entries()].filter(([, copy]) => copy.text !== copy.baseText).map(([key, copy]) => ({
      key,
      resource: { ...copy.resource },
      text: copy.text,
      baseText: copy.baseText,
      etag: copy.etag,
      savedAt: new Date().toISOString(),
    }))
  }

  #changed(): void {
    for (const listener of this.#listeners)
      listener()
  }
}
