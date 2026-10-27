import type { ExtensionLocalFile } from '../../shared/extensions/extensionResources'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

export class ExtensionResourceUpload<T = ExtensionLocalFile> {
  readonly id = randomUUID()
  readonly finished: Promise<T>
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>
  readonly #abort = new AbortController()
  readonly #size: number
  readonly #assertCurrent: () => void
  #written = 0
  #ended = false
  #tail: Promise<unknown> = Promise.resolve()

  constructor(size: number, publish: (body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<T>, assertCurrent: () => void) {
    this.#size = size
    this.#assertCurrent = assertCurrent
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    this.#writer = stream.writable.getWriter()
    this.finished = publish(stream.readable, this.#abort.signal)
    void this.finished.catch(error => this.#writer.abort(error).catch(() => {}))
  }

  append(offset: number, base64: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assert()
      const data = Buffer.from(base64, 'base64')
      if (offset !== this.#written || !data.length || data.length > 96 * 1024 || this.#written + data.length > this.#size)
        throw new Error('EXTENSION_RESOURCE_WRITE_RANGE')
      await this.#writer.write(data)
      this.#written += data.length
    })
  }

  commit(): Promise<T> {
    return this.#enqueue(async () => {
      this.#assert()
      if (this.#written !== this.#size)
        throw new Error('EXTENSION_RESOURCE_WRITE_INCOMPLETE')
      this.#ended = true
      await this.#writer.close()
      return this.finished
    })
  }

  async dispose(): Promise<void> {
    this.#ended = true
    this.#abort.abort(new Error('EXTENSION_RESOURCE_WRITE_CANCELLED'))
    await this.#writer.abort(new Error('EXTENSION_RESOURCE_WRITE_CANCELLED')).catch(() => {})
    await this.finished.catch(() => {})
  }

  #assert(): void {
    if (this.#ended)
      throw new Error('EXTENSION_RESOURCE_WRITE_EXPIRED')
    this.#assertCurrent()
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.catch(() => {}).then(operation)
    this.#tail = task
    return task
  }
}
