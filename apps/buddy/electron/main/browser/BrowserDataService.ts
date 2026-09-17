import type { BrowserClearDataInput, BrowserClearDataResult, BrowserDataSummary } from '../../../shared/browser/browserData'
import type { BrowserHost } from './BrowserHost'
import type { BrowserOperationGuard } from './BrowserOperationGuard'
import { session } from 'electron'
import { clearBrowserData, readBrowserDataSummary } from './browserData'
import { BROWSER_DEFAULT_PARTITION } from './BrowserHost'
import { BrowserHostError } from './BrowserHostError'

export class BrowserDataService {
  readonly #getHost: () => BrowserHost | null
  readonly #operations: BrowserOperationGuard

  constructor(getHost: () => BrowserHost | null, operations: BrowserOperationGuard) {
    this.#getHost = getHost
    this.#operations = operations
  }

  getSummary(): Promise<BrowserDataSummary> {
    return readBrowserDataSummary(this.#sessions())
  }

  async clear(input: BrowserClearDataInput): Promise<BrowserClearDataResult> {
    try {
      await this.#operations.runMaintenance(async () => {
        if (this.#getHost()?.hasAgentControl())
          throw new BrowserHostError('BROWSER_IN_USE', 'Browser is controlled by an agent')
        await clearBrowserData(this.#sessions(), input)
      })
      return { ok: true }
    }
    catch (error) {
      return { ok: false, code: error instanceof BrowserHostError && error.code === 'BROWSER_IN_USE' ? 'BROWSER_IN_USE' : 'BROWSER_CLEAR_FAILED' }
    }
  }

  #sessions() {
    const partitions = new Set([BROWSER_DEFAULT_PARTITION, ...this.#getHost()?.listGuests().map(guest => guest.partition) ?? []])
    return [...partitions].map(partition => session.fromPartition(partition))
  }
}
