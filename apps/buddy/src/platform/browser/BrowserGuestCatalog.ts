import type { DesktopBrowserApi, DesktopBrowserGuestDescriptor } from '@buddy-electron/shared/desktopApi'
import { readonly, shallowRef } from 'vue'

export class BrowserGuestCatalog {
  readonly #api: Pick<DesktopBrowserApi, 'listGuests' | 'onGuestsChanged'>
  readonly #snapshot = shallowRef<readonly DesktopBrowserGuestDescriptor[] | null>(null)
  readonly snapshot = readonly(this.#snapshot)
  readonly #listeners = new Set<() => void>()
  readonly #stop: () => void
  #revision = 0
  #disposed = false
  #pending: Promise<readonly DesktopBrowserGuestDescriptor[]> | null = null

  constructor(api: Pick<DesktopBrowserApi, 'listGuests' | 'onGuestsChanged'>) {
    this.#api = api
    this.#stop = api.onGuestsChanged(() => {
      this.#revision += 1
      void this.refresh().catch(() => {})
      for (const listener of this.#listeners)
        listener()
    })
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  refresh(): Promise<readonly DesktopBrowserGuestDescriptor[]> {
    if (this.#disposed)
      return Promise.resolve(this.#snapshot.value ?? [])
    if (this.#pending)
      return this.#pending
    this.#pending = this.#read().finally(() => this.#pending = null)
    return this.#pending
  }

  async #read(): Promise<readonly DesktopBrowserGuestDescriptor[]> {
    while (!this.#disposed) {
      const revision = this.#revision
      let guests: readonly DesktopBrowserGuestDescriptor[]
      try {
        guests = await this.#api.listGuests()
      }
      catch (error) {
        if (!this.#disposed && revision !== this.#revision)
          continue
        throw error
      }
      if (this.#disposed)
        break
      if (revision !== this.#revision)
        continue
      this.#snapshot.value = guests
      return guests
    }
    return this.#snapshot.value ?? []
  }

  dispose(): void {
    this.#disposed = true
    this.#revision += 1
    this.#stop()
    this.#listeners.clear()
  }
}
