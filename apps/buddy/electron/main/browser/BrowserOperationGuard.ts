import { BrowserHostError } from './BrowserHostError'

export class BrowserOperationGuard {
  #maintenance = false

  assertCanMutate(): void {
    if (this.#maintenance)
      throw new BrowserHostError('BROWSER_IN_USE', 'Browser data maintenance is in progress')
  }

  async runMaintenance(operation: () => Promise<void>): Promise<void> {
    this.assertCanMutate()
    this.#maintenance = true
    try {
      await operation()
    }
    finally {
      this.#maintenance = false
    }
  }
}
