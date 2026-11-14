import type { SocketFrames } from './SocketFrames'
import { Emitter } from '../../shared/events/Emitter'
import { RuntimeRpcPeer } from '../ipc/runtimeRpcPeer'

export class ServiceRpcChannel extends RuntimeRpcPeer {
  readonly #frames: SocketFrames
  readonly #closed = new Emitter<void>(() => {})
  readonly onDidClose = this.#closed.event
  #ended = false

  constructor(frames: SocketFrames) {
    super({ transport: frames.transport(), onFatalError: error => frames.close(error) })
    this.#frames = frames
    frames.onDidClose(error => this.close(error))
  }

  get closed(): boolean { return this.#ended }

  override close(reason: Error): void {
    if (this.#ended)
      return
    this.#ended = true
    super.close(reason)
    this.#frames.close(reason)
    this.#closed.fire()
    this.#closed.dispose()
  }
}
