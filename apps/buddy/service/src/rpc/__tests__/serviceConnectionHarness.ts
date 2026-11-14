import type { RuntimeWireMessage } from '../../../../shared/runtime/runtimeProtocol'
import { EventEmitter } from 'node:events'
import { RuntimeRpcPeer } from '../../../../platform/ipc/runtimeRpcPeer'
import { BuddyServiceRpcServer } from '../BuddyServiceRpcServer'

export function createServiceConnection() {
  const incoming = new EventEmitter()
  const outgoing = new EventEmitter()
  const received: RuntimeWireMessage[] = []
  const server = new BuddyServiceRpcServer({ port: {
    postMessage(message) {
      received.push(structuredClone(message) as RuntimeWireMessage)
      queueMicrotask(() => outgoing.emit('message', message))
    },
    on: (event, listener) => incoming.on(event, listener),
    off: (event, listener) => incoming.off(event, listener),
  } })
  const client = new RuntimeRpcPeer({ transport: {
    postMessage: message => queueMicrotask(() => incoming.emit('message', { data: message })),
    subscribe(listener) {
      outgoing.on('message', listener)
      return () => outgoing.off('message', listener)
    },
  } })
  server.onDidClose(() => client.close(new Error('Connection closed')))
  return {
    server,
    client,
    received,
    sendInvalid: () => incoming.emit('message', { data: { invalid: true } }),
    close: () => server.close(new Error('Connection closed')),
  }
}
