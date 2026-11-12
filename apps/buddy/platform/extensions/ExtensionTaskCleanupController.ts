import type { ExtensionTaskCleanupPreview, ExtensionTaskCleanupProgress } from '../../shared/extensions/extensionTaskCleanup'
import type { ExtensionTaskCleanupBatchResult } from './ExtensionTaskCleanupBatch'
import { runExtensionTaskCleanupBatch } from './ExtensionTaskCleanupBatch'

interface ActiveCleanup {
  extensionId: string
  confirmed: boolean
  cancel: (expired?: boolean) => void
}

export class ExtensionTaskCleanupController {
  #active?: ActiveCleanup

  cancelUnconfirmed(extensionId?: string): void {
    if (this.#active && !this.#active.confirmed && (!extensionId || this.#active.extensionId === extensionId))
      this.#active.cancel()
  }

  async run(options: Omit<Parameters<typeof runExtensionTaskCleanupBatch>[0], 'confirm'> & {
    extensionId: string
    signal: AbortSignal
    confirm: (preview: ExtensionTaskCleanupPreview, signal: AbortSignal) => Promise<boolean>
  }): Promise<ExtensionTaskCleanupBatchResult> {
    if (this.#active)
      throw new Error('EXTENSION_TASK_CLEANUP_BUSY')
    options.assertCurrent()
    const hidden = new AbortController()
    const signal = AbortSignal.any([options.signal, hidden.signal])
    let progress: ExtensionTaskCleanupProgress = { phase: 'scanning', total: null, processed: 0, deleted: 0, pending: 0, failed: 0, skipped: 0, errorCode: null }
    let delivery = Promise.resolve()
    const publish = (value: ExtensionTaskCleanupProgress) => {
      delivery = Promise.resolve().then(() => options.progress?.(value)).then(() => {}, () => {})
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
      extensionId: options.extensionId,
      confirmed: false,
      cancel: (expired = false) => {
        if (active.confirmed || hidden.signal.aborted)
          return
        progress = { ...progress, phase: expired ? 'failed' : 'cancelled', errorCode: expired ? 'EXTENSION_TASK_CLEANUP_EXPIRED' : null }
        if (this.#active === active)
          this.#active = undefined
        hidden.abort()
        finishHidden({ status: expired ? 'completed' : 'cancelled', results: [], summary: { ...progress } })
      },
    }
    this.#active = active
    let finishExpired!: () => void
    const expired = new Promise<void>((resolve) => {
      finishExpired = resolve
    })
    const expire = () => {
      active.cancel(true)
      finishExpired()
    }
    options.signal.addEventListener('abort', expire, { once: true })
    if (options.signal.aborted)
      expire()
    try {
      const result = await Promise.race([hiddenResult, runExtensionTaskCleanupBatch({
        cleanup: options.cleanup,
        assertCurrent,
        progress: (value) => {
          if (hidden.signal.aborted)
            return
          progress = { ...value }
          return publish(value)
        },
        confirm: preview => new Promise<boolean>((resolve, reject) => {
          let settled = false
          const abort = () => finish(false, new Error('EXTENSION_TASK_CLEANUP_EXPIRED'))
          function finish(confirmed: boolean, error?: unknown) {
            if (settled)
              return
            settled = true
            signal.removeEventListener('abort', abort)
            if (error) {
              reject(error)
              return
            }
            try {
              assertCurrent()
              if (typeof confirmed !== 'boolean')
                throw new Error('EXTENSION_INVALID_ARGUMENT')
              active.confirmed = confirmed === true
              resolve(confirmed)
            }
            catch (error) { reject(error) }
          }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) {
            abort()
            return
          }
          Promise.resolve().then(() => {
            assertCurrent()
            return options.confirm(preview, signal)
          }).then(value => finish(value), error => finish(false, error))
        }),
      })])
      if (hidden.signal.aborted && !options.signal.aborted) {
        await Promise.race([expired, delivery.then(() => {
          if (!options.signal.aborted)
            return publish(result.summary)
        })])
      }
      return result
    }
    finally {
      options.signal.removeEventListener('abort', expire)
      if (this.#active === active)
        this.#active = undefined
    }
  }
}
