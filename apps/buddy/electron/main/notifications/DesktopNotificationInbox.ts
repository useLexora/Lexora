import type { PublishedDeviceNotification } from '../../shared/desktopNotifications'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { readStorageJson, writeStorageJson } from '../../../platform/storage/storageFiles'
import { Emitter } from '../../../shared/events/Emitter'

interface Fact { readonly id: string, readonly revision: string }
type Entry<T> = T & { attention: 'seen' | 'unseen' }
interface ReadTarget { notificationId: string, revision: string }
const seenRevisions = z.record(z.string(), z.string())

export class DesktopNotificationInbox<T extends Fact = PublishedDeviceNotification> {
  readonly #path: string
  readonly #onError: (error: unknown) => void
  readonly #entries = new Map<string, T>()
  readonly #changed = new Emitter<void>(() => {})
  readonly onChanged = this.#changed.event
  #tail: Promise<unknown> = Promise.resolve()

  constructor(attentionPath: string, onError: (error: unknown) => void) {
    this.#path = attentionPath
    this.#onError = onError
  }

  publish(entry: T) {
    const previous = this.#entries.get(entry.id)
    if (isDeepStrictEqual(previous, entry))
      return
    this.#entries.set(entry.id, entry)
    if (previous && previous.revision !== entry.revision)
      this.#forget(entry.id)
    this.#changed.fire()
  }

  withdraw(id: string) {
    if (this.#entries.delete(id)) {
      this.#forget(id)
      this.#changed.fire()
    }
  }

  list(): Promise<Entry<T>[]> {
    return this.#snapshot()
  }

  markSeen(target: ReadTarget): Promise<Entry<T>[]> {
    return this.#snapshot([target])
  }

  markAllSeen(): Promise<Entry<T>[]> {
    return this.#snapshot([...this.#entries.values()].map(entry => ({ notificationId: entry.id, revision: entry.revision })))
  }

  #snapshot(targets?: ReadTarget[]): Promise<Entry<T>[]> {
    return this.#serial(async () => {
      if (!this.#entries.size)
        return []
      const revisions = await this.#readAttention()
      let changed = false
      for (const { notificationId, revision } of targets ?? []) {
        if (this.#entries.get(notificationId)?.revision === revision && revisions[notificationId] !== revision) {
          revisions[notificationId] = revision
          changed = true
        }
      }
      if (changed) {
        await writeStorageJson(this.#path, revisions)
        this.#changed.fire()
      }
      return [...this.#entries.values()].map((entry): Entry<T> => ({
        ...entry,
        attention: revisions[entry.id] === entry.revision ? 'seen' : 'unseen',
      }))
    })
  }

  reconcileReadState(prefix: string): Promise<void> {
    return this.#prune(id => id.startsWith(prefix) && !this.#entries.has(id))
  }

  #forget(id: string) {
    void this.#prune(key => key === id).catch(this.#onError)
  }

  #prune(remove: (id: string) => boolean): Promise<void> {
    return this.#serial(async () => {
      const revisions = await this.#readAttention()
      const obsolete = Object.keys(revisions).filter(remove)
      if (obsolete.length) {
        for (const id of obsolete)
          delete revisions[id]
        await writeStorageJson(this.#path, revisions)
      }
    })
  }

  #serial<R>(work: () => Promise<R>): Promise<R> {
    const next = this.#tail.then(work)
    this.#tail = next.catch(() => {})
    return next
  }

  async #readAttention(): Promise<Record<string, string>> {
    try {
      return seenRevisions.parse(await readStorageJson(this.#path) ?? {})
    }
    catch (error) {
      this.#onError(error)
      return {}
    }
  }

  dispose() {
    this.#changed.dispose()
  }
}
