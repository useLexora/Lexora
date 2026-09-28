import type { Event, ListenerErrorHandler } from '@buddy-shared/events/Emitter'
import type { ReadonlyJsonValue, WorkbenchState } from '@buddy-shared/workbench/workbenchState'
import type { WorkingCopy, WorkingCopyService } from './WorkingCopyService'
import { Emitter } from '@buddy-shared/events/Emitter'
import { copyEventSnapshot } from '@buddy-shared/events/eventSnapshot'

export interface WorkingCopyBackupChange {
  readonly revision: number
  readonly sourceRevision: number
  readonly keys: readonly string[]
}
export interface WorkingCopyBackupStatus {
  readonly revision: number
  readonly savedRevision: number
  readonly health: 'ready' | 'degraded' | 'disposed'
}
export interface WorkingCopyBackupSnapshot {
  readonly revision: number
  readonly backups: readonly WorkingCopyBackupRecord[]
}
type WorkingCopyBackupRecord = Readonly<Omit<WorkbenchState['backups'][number], 'resource'>> & { readonly resource: ReadonlyJsonValue }
interface BackupEntry {
  copy: WorkingCopy
  backup: WorkingCopyBackupRecord
}

export class WorkingCopyBackup {
  readonly #copies: WorkingCopyService
  #entries = new Map<string, BackupEntry>()
  readonly #changes: Emitter<WorkingCopyBackupChange>
  readonly #status: Emitter<WorkingCopyBackupStatus>
  readonly #flush: (revision: number) => Promise<void>
  readonly #stop: () => void
  #revision = 0
  #sourceRevision = 0
  #savedRevision = 0
  #health: WorkingCopyBackupStatus['health'] = 'ready'

  constructor(copies: WorkingCopyService, flush: (revision: number) => Promise<void>, onListenerError: ListenerErrorHandler = () => console.error('WORKING_COPY_BACKUP_OBSERVER_FAILED')) {
    this.#copies = copies
    this.#flush = flush
    this.#changes = new Emitter(onListenerError)
    this.#status = new Emitter(onListenerError)
    this.#stop = copies.onDidChange((event) => {
      if (event.revision <= this.#sourceRevision)
        return
      this.#sourceRevision = event.revision
      this.#update(event.copy, event.revision, event.kind === 'released')
    }).dispose
    this.resync()
  }

  readonly onDidChange: Event<WorkingCopyBackupChange> = (listener, options) => this.#changes.event(listener, options)
  readonly onDidChangeStatus: Event<WorkingCopyBackupStatus> = (listener, options) => this.#status.event(listener, options)
  get revision(): number { return this.#revision }
  get savedRevision(): number { return this.#savedRevision }
  get status(): WorkingCopyBackupStatus { return copyEventSnapshot({ revision: this.#revision, savedRevision: this.#savedRevision, health: this.#health }) }

  snapshot(): WorkingCopyBackupSnapshot {
    return Object.freeze({ revision: this.#revision, backups: Object.freeze([...this.#entries.values()].map(entry => entry.backup)) })
  }

  resync(): void {
    if (this.#health === 'disposed')
      return
    const sourceRevision = this.#copies.revision
    const next = new Map<string, BackupEntry>()
    const keys: string[] = []
    for (const copy of this.#copies.copies.values()) {
      if (!copy.dirty)
        continue
      const previous = this.#entries.get(copy.key)
      if (previous && this.#same(previous.copy, copy)) {
        next.set(copy.key, previous)
      }
      else {
        next.set(copy.key, this.#entry(copy))
        keys.push(copy.key)
      }
    }
    for (const key of this.#entries.keys()) {
      if (!next.has(key))
        keys.push(key)
    }
    this.#sourceRevision = sourceRevision
    this.#entries = next
    if (keys.length)
      this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, sourceRevision, keys }))
  }

  async flushThrough(revision = this.#revision): Promise<void> {
    if (this.#health === 'disposed')
      throw new Error('WORKING_COPY_BACKUP_DISPOSED')
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.#revision)
      throw new Error('WORKING_COPY_BACKUP_INVALID_REVISION')
    if (this.#savedRevision >= revision)
      return
    await this.#flush(revision)
    if (this.#savedRevision < revision)
      throw new Error('WORKING_COPY_BACKUP_NOT_PERSISTED')
  }

  acceptPersisted(revision: number): void {
    if (revision < this.#savedRevision || revision > this.#revision)
      throw new Error('WORKING_COPY_BACKUP_INVALID_RECEIPT')
    const changed = this.#savedRevision !== revision || this.#health === 'degraded'
    this.#savedRevision = revision
    if (this.#health !== 'disposed')
      this.#health = 'ready'
    if (changed)
      this.#status.fire(this.status)
  }

  markWriteFailed(): void {
    if (this.#health !== 'ready')
      return
    this.#health = 'degraded'
    this.#status.fire(this.status)
  }

  dispose(): void {
    this.#health = 'disposed'
    this.#stop()
    this.#status.fire(this.status)
    this.#changes.dispose()
    this.#status.dispose()
  }

  #update(copy: WorkingCopy, sourceRevision: number, released: boolean): void {
    const previous = this.#entries.get(copy.key)
    if (released || !copy.dirty) {
      if (!previous)
        return
      this.#entries.delete(copy.key)
    }
    else {
      if (previous && this.#same(previous.copy, copy))
        return
      this.#entries.set(copy.key, this.#entry(copy))
    }
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, sourceRevision, keys: [copy.key] }))
  }

  #same(previous: WorkingCopy, current: WorkingCopy): boolean {
    return previous.incarnation === current.incarnation && previous.text === current.text && previous.baseText === current.baseText && previous.etag === current.etag
  }

  #entry(copy: WorkingCopy): BackupEntry {
    return {
      copy,
      backup: copyEventSnapshot({ key: copy.key, resource: JSON.parse(JSON.stringify(copy.resource)), text: copy.text, baseText: copy.baseText, etag: copy.etag, savedAt: new Date().toISOString() }),
    }
  }
}
