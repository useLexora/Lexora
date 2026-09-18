import type { ExtensionInstallation, ExtensionInstallationStage } from '../../shared/extensions/extensionInstallation'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { extensionError } from '../../shared/extensions/extensionApi'
import { extensionInstallationSchema } from '../../shared/extensions/extensionInstallation'
import { readExtensionJson, writeExtensionJson } from './extensionFiles'

export class ExtensionInstallations {
  readonly #path: string
  readonly #changed: () => void
  readonly #controllers = new Map<string, AbortController>()
  #records: ExtensionInstallation[] = []
  #writing = Promise.resolve()
  #scheduled: ReturnType<typeof setTimeout> | undefined

  constructor(root: string, changed: () => void) {
    this.#path = join(root, 'installation-log.json')
    this.#changed = changed
  }

  async load(): Promise<void> {
    try {
      this.#records = z.array(extensionInstallationSchema).max(50).parse(await readExtensionJson(this.#path, 4 * 1024 * 1024)).map(record => ['running', 'review'].includes(record.status) ? { ...record, status: 'cancelled', error: 'EXTENSION_INSTALL_INTERRUPTED' } : record)
    }
    catch {
      this.#records = []
    }
  }

  list(): ExtensionInstallation[] {
    return structuredClone(this.#records)
  }

  begin(name: string, stage: ExtensionInstallationStage): { id: string, signal: AbortSignal } {
    const id = randomUUID()
    const controller = new AbortController()
    this.#controllers.set(id, controller)
    const record: ExtensionInstallation = { id, name: name.slice(0, 120), startedAt: new Date().toISOString(), status: 'running', stage, entries: [], error: null }
    this.#records = [record, ...this.#records].slice(0, 50)
    this.log(id, stage, 'started')
    return { id, signal: controller.signal }
  }

  signal(id: string): AbortSignal {
    const controller = this.#controllers.get(id)
    if (!controller || controller.signal.aborted)
      throw new Error('EXTENSION_INSTALL_CANCELLED')
    return controller.signal
  }

  log(id: string, stage: ExtensionInstallationStage, message: string): void {
    const record = this.#records.find(item => item.id === id)
    if (!record || (stage !== 'completed' && ['completed', 'failed', 'cancelled'].includes(record.status)))
      return
    record.stage = stage
    record.status = stage === 'review' ? 'review' : stage === 'completed' ? 'completed' : 'running'
    if (stage === 'completed')
      record.error = null
    record.entries = [...record.entries, { time: new Date().toISOString(), stage, message: message.slice(0, 600) }].slice(-100)
    if (stage === 'completed')
      this.#controllers.delete(id)
    this.#save()
  }

  failed(id: string, error: unknown): void {
    const record = this.#records.find(item => item.id === id)
    if (!record || record.status === 'completed')
      return
    record.error = extensionError(error)
    record.status = record.error === 'EXTENSION_INSTALL_CANCELLED' || this.#controllers.get(id)?.signal.aborted ? 'cancelled' : 'failed'
    record.entries = [...record.entries, { time: new Date().toISOString(), stage: record.stage, message: record.error }].slice(-100)
    this.#controllers.delete(id)
    this.#save()
  }

  cancel(id: string): void {
    const controller = this.#controllers.get(id)
    if (!controller)
      return
    controller.abort(new Error('EXTENSION_INSTALL_CANCELLED'))
    this.failed(id, new Error('EXTENSION_INSTALL_CANCELLED'))
  }

  async dispose(): Promise<void> {
    for (const id of this.#controllers.keys()) this.cancel(id)
    clearTimeout(this.#scheduled)
    this.#flush()
    await this.#writing
  }

  #save(): void {
    if (!this.#scheduled)
      this.#scheduled = setTimeout(() => this.#flush(), 50)
  }

  #flush(): void {
    this.#scheduled = undefined
    const records = this.list()
    this.#writing = this.#writing.catch(() => {}).then(() => writeExtensionJson(this.#path, records)).catch(() => {})
    this.#changed()
  }
}
