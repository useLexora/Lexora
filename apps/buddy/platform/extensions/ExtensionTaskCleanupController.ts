import type { ExtensionTaskCleanupConfirmation, ExtensionTaskCleanupOperation, ExtensionTaskCleanupProgress } from '../../shared/extensions/extensionTaskCleanup'
import type { ExtensionTaskCleanupBatchResult } from './ExtensionTaskCleanupBatch'
import { randomUUID } from 'node:crypto'
import { runExtensionTaskCleanupBatch } from './ExtensionTaskCleanupBatch'

interface ActiveCleanup {
  operation: ExtensionTaskCleanupOperation
  assertCurrent: () => void
  confirmed: boolean
  cancel: () => void
  decide?: (confirmed: boolean) => void
}

export class ExtensionTaskCleanupController {
  readonly #operations = new Map<string, ExtensionTaskCleanupOperation>()
  #active?: ActiveCleanup

  private readonly changed: (extensionId: string) => void

  constructor(changed: (extensionId: string) => void) {
    this.changed = changed
  }

  snapshot(extensionId: string): ExtensionTaskCleanupOperation | undefined {
    const operation = this.#operations.get(extensionId)
    return operation ? { ...operation } : undefined
  }

  confirmations(): ExtensionTaskCleanupConfirmation[] {
    const active = this.#active
    if (!active?.decide || active.operation.phase !== 'confirming' || active.operation.total === null)
      return []
    const { id, extensionId, total, skipped } = active.operation
    return [{ id, extensionId, total, skipped }]
  }

  confirm(extensionId: string, operationId: string, confirmed: boolean): void {
    const active = this.#active
    if (!active || active.operation.extensionId !== extensionId || active.operation.id !== operationId || active.operation.phase !== 'confirming' || !active.decide)
      throw new Error('EXTENSION_TASK_CLEANUP_EXPIRED')
    active.assertCurrent()
    active.decide(confirmed)
  }

  cancelUnconfirmed(): void {
    const active = this.#active
    if (active && !active.confirmed && (active.operation.phase === 'scanning' || active.operation.phase === 'confirming'))
      active.cancel()
  }

  async run(options: Omit<Parameters<typeof runExtensionTaskCleanupBatch>[0], 'confirm'> & {
    extensionId: string
    menuId: string
    signal: AbortSignal
    confirm?: Parameters<typeof runExtensionTaskCleanupBatch>[0]['confirm']
  }): Promise<ExtensionTaskCleanupBatchResult> {
    if (this.#active)
      throw new Error('EXTENSION_TASK_CLEANUP_BUSY')
    options.assertCurrent()
    const operation: ExtensionTaskCleanupOperation = { id: randomUUID(), extensionId: options.extensionId, menuId: options.menuId, phase: 'scanning', total: null, processed: 0, deleted: 0, pending: 0, failed: 0, skipped: 0, errorCode: null }
    this.#operations.set(options.extensionId, { ...operation })
    const hidden = new AbortController()
    const signal = AbortSignal.any([options.signal, hidden.signal])
    let delivery = Promise.resolve()
    const publish = (progress: ExtensionTaskCleanupProgress) => {
      delivery = Promise.resolve().then(() => options.progress?.(progress)).then(() => {}, () => {})
      return delivery
    }
    let finishHidden!: (result: ExtensionTaskCleanupBatchResult) => void
    const hiddenResult = new Promise<ExtensionTaskCleanupBatchResult>((resolve) => {
      finishHidden = resolve
    })
    const assertCurrent = () => {
      options.assertCurrent()
      if (signal.aborted)
        throw new Error('EXTENSION_TASK_CLEANUP_EXPIRED')
    }
    const active: ActiveCleanup = {
      operation,
      assertCurrent,
      confirmed: false,
      cancel: () => {
        operation.phase = 'cancelled'
        operation.errorCode = null
        this.#operations.set(options.extensionId, { ...operation })
        this.#active = undefined
        hidden.abort()
        const { id: _id, extensionId: _extensionId, menuId: _menuId, ...summary } = operation
        finishHidden({ status: 'cancelled', results: [], summary })
      },
    }
    this.#active = active
    try {
      const result = await Promise.race([hiddenResult, runExtensionTaskCleanupBatch({
        cleanup: options.cleanup,
        assertCurrent,
        progress: (progress) => {
          if (hidden.signal.aborted)
            return
          Object.assign(operation, progress)
          this.#operations.set(options.extensionId, { ...operation })
          return publish(progress)
        },
        confirm: (count, check) => new Promise<boolean>((resolve, reject) => {
          const notify = () => this.changed(options.extensionId)
          const abort = () => {
            try {
              assertCurrent()
            }
            catch (error) {
              finish(false, error)
            }
          }
          let settled = false
          let announced = false
          function finish(confirmed: boolean, error?: unknown) {
            if (settled)
              return
            settled = true
            active.decide = undefined
            signal.removeEventListener('abort', abort)
            active.confirmed = !error && confirmed
            if (announced)
              notify()
            if (error)
              reject(error)
            else resolve(confirmed)
          }
          active.decide = confirmed => finish(confirmed)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) {
            abort()
            return
          }
          announced = true
          this.changed(options.extensionId)
          if (options.confirm)
            void options.confirm(count, check).then(value => finish(value), error => finish(false, error))
        }),
      })])
      if (hidden.signal.aborted) {
        await delivery
        await publish(result.summary)
      }
      return result
    }
    finally {
      if (this.#active === active)
        this.#active = undefined
    }
  }
}
