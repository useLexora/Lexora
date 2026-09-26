import type { WorkbenchStateApi } from '@buddy-shared/workbench/workbenchState'
import type { WorkbenchController } from './WorkbenchController'
import type { WorkingCopyService } from './WorkingCopyService'
import { resourceKey } from '../common/workbench'
import { restoreWorkbenchLayout } from './WorkbenchController'

export class WorkbenchPersistence {
  readonly #api: WorkbenchStateApi
  readonly #controller: WorkbenchController
  readonly #copies: WorkingCopyService
  readonly #report: (error: unknown | null) => void
  #timer: ReturnType<typeof setTimeout> | undefined
  #deadline: ReturnType<typeof setTimeout> | undefined
  #tail: Promise<void> = Promise.resolve()
  #revision = 0
  #saved = 0
  #ready = false
  #restored = false
  #stop: Array<() => void> = []

  constructor(api: WorkbenchStateApi, controller: WorkbenchController, copies: WorkingCopyService, report: (error: unknown | null) => void) {
    this.#api = api
    this.#controller = controller
    this.#copies = copies
    this.#report = report
  }

  async restore(prepareLayout?: (layout: WorkbenchController['layout']) => Promise<void>): Promise<boolean> {
    if (this.#ready)
      return this.#restored
    const state = await this.#api.read()
    if (state) {
      this.#controller.configuration.restore(state.configuration)
      this.#controller.layout = restoreWorkbenchLayout(state.layout)
      await prepareLayout?.(this.#controller.layout)
      this.#copies.restore(state.backups)
      for (const copy of this.#copies.copies.values()) {
        if (!Object.values(this.#controller.layout.views).some(view => resourceKey(view.resource) === resourceKey(copy.resource))) {
          try {
            await this.#controller.open(copy.resource, copy.resource.id.split('/').at(-1) ?? copy.resource.id)
          }
          catch {
            // Unavailable factories must not remove an independent working-copy backup.
          }
        }
      }
    }
    this.#restored = state !== null
    this.#ready = true
    this.#stop = [this.#controller.subscribe(() => this.#schedule()), this.#copies.subscribe(() => this.#schedule()), this.#controller.configuration.subscribe(() => this.#schedule())]
    this.#controller.changed()
    return this.#restored
  }

  flush(): Promise<void> {
    clearTimeout(this.#timer)
    clearTimeout(this.#deadline)
    this.#deadline = undefined
    if (!this.#ready)
      return Promise.resolve()
    this.#tail = this.#tail.catch(() => {}).then(async () => {
      while (this.#saved !== this.#revision) {
        const revision = this.#revision
        const snapshot = JSON.parse(JSON.stringify({ version: 1, layout: { ...this.#controller.layout, views: Object.fromEntries(Object.entries(this.#controller.layout.views).filter(([, view]) => !view.interactionId)) }, backups: this.#copies.backups(), configuration: this.#controller.configuration.snapshot() }))
        await this.#api.write(snapshot)
        this.#saved = revision
      }
      this.#report(null)
    }).catch((error: unknown) => {
      this.#report(error)
      throw error
    })
    return this.#tail
  }

  dispose(): void {
    clearTimeout(this.#timer)
    clearTimeout(this.#deadline)
    this.#stop.forEach(stop => stop())
    this.#stop = []
  }

  #schedule(): void {
    this.#revision += 1
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush().catch(() => {}), 350)
    this.#deadline ??= setTimeout(() => void this.flush().catch(() => {}), 2000)
  }
}
