import type { z } from 'zod'
import type { ProductRpcClient } from './ProductRpcClient'
import { CONVERSATION_CHANGED, conversationSchema } from '../../../shared/conversation/conversationApi'
import { productTaskSummarySchema } from '../../../shared/productProtocol/queries'
import { decodeSafeProductRevision } from '../../../shared/productProtocol/scalars'
import { productTaskIndexChangeSchema } from '../../../shared/productProtocol/topics'
import { ProductSyncClient } from './ProductSyncClient'

type Task = z.infer<typeof productTaskSummarySchema>

export class DesktopTaskSynchronization {
  readonly #sync: ProductSyncClient
  readonly #notify: (notification: { method: string, params: unknown }) => void
  #closed = false
  #tasks = new Map<string, Task>()
  #retry: ReturnType<typeof setTimeout> | undefined

  constructor(client: ProductRpcClient, notify: (notification: { method: string, params: unknown }) => void) {
    this.#sync = new ProductSyncClient(client)
    this.#notify = notify
    this.#subscribe()
  }

  close(): void {
    this.#closed = true
    clearTimeout(this.#retry)
    this.#sync.close()
    this.#tasks.clear()
  }

  #subscribe(): void {
    if (this.#closed)
      return
    let staged = new Map<string, Task>()
    const handle = this.#sync.subscribe('taskIndex', {
      item: productTaskSummarySchema,
      change: productTaskIndexChangeSchema,
      beginSnapshot: () => { staged = new Map() },
      appendSnapshot: (tasks) => { for (const task of tasks) staged.set(task.id, task) },
      commitSnapshot: () => {
        if (this.#closed)
          return
        for (const [id, task] of this.#tasks) {
          if (!staged.has(id))
            this.#publish(task, true)
        }
        this.#tasks = staged
        for (const task of staged.values()) this.#publish(task)
      },
      applyChanges: (changes) => {
        if (this.#closed)
          return
        const next = new Map(this.#tasks)
        for (const change of changes) {
          if (change.kind === 'remove') {
            const previous = next.get(change.id)
            next.delete(change.id)
            if (previous)
              this.#publish(previous, true)
          }
          else {
            next.set(change.value.id, change.value)
            this.#publish(change.value)
          }
        }
        this.#tasks = next
      },
      invalidate: () => {
        if (!this.#closed) {
          clearTimeout(this.#retry)
          this.#retry = setTimeout(() => this.#subscribe(), 1000)
        }
      },
    })
    void handle.ready.catch(() => {})
  }

  #publish(task: Task, deleted = false): void {
    const fields = Object.fromEntries(Object.keys(conversationSchema.shape).filter(key => key in task).map(key => [key, task[key as keyof Task]]))
    const value = conversationSchema.parse({ ...fields, metadataRevision: decodeSafeProductRevision(task.revision), titleRevision: decodeSafeProductRevision(task.titleRevision), ...(deleted ? { deletedAt: new Date().toISOString() } : {}) })
    this.#notify({ method: CONVERSATION_CHANGED, params: value })
  }
}
