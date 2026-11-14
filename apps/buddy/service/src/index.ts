import type { BuddyServiceParentPort } from './rpc/BuddyServiceRpcServer'
import type { ServiceClientRole } from './rpc/ServiceClientConnections'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { z } from 'zod'
import { ApplicationEvents } from '../../shared/observability/ApplicationEvents'
import { BUDDY_SERVICE_PROTOCOL_VERSION } from '../../shared/runtime/runtimeProtocol'
import { startLocalServiceSupervisor } from './LocalServiceSupervisor'
import { createRpcRuntimePlatform } from './platform/createRpcRuntimePlatform'
import { nodeServiceConfigSchema, prepareNodeService } from './platform/nodeServiceConfig'
import { BuddyServiceRpcServer, notifyBuddyServiceReady } from './rpc/BuddyServiceRpcServer'
import { registerServiceManagementRpc } from './rpc/registerServiceManagementRpc'
import { readBuddyServiceFailureCode, startServiceRuntime } from './startServiceRuntime'

const channelId = z.string().min(1).max(128).refine(value => value !== 'host')
const incomingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), protocolVersion: z.literal(BUDDY_SERVICE_PROTOCOL_VERSION), config: nodeServiceConfigSchema }).strict(),
  z.object({ type: z.literal('connect'), channel: channelId, role: z.enum(['product', 'management']) }).strict(),
  z.object({ type: z.literal('disconnect'), channel: channelId }).strict(),
  z.object({ type: z.literal('rpc'), channel: z.string().min(1).max(128), message: z.unknown() }).strict(),
])

if (process.argv[2] === '--config' && process.argv.length === 4) {
  const supervisor = startLocalServiceSupervisor(process.argv[3]!)
  const stop = () => {
    void supervisor.stop().catch(() => {
      process.stderr.write('SERVICE_STOP_FAILED\n')
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  void supervisor.ready.catch(() => {
    process.stderr.write('SERVICE_START_FAILED\n')
    process.exitCode = 1
  })
}
else if (!process.send) {
  process.stderr.write('Lexora Server requires an inherited local IPC channel\n')
  process.exitCode = 1
}
else {
  const events = new ApplicationEvents()
  const channelIds = new Set<string>()
  const channels = new Map<string, { port: EventEmitter & BuddyServiceParentPort, peer: BuddyServiceRpcServer }>()
  let started: ReturnType<typeof start> | undefined
  let runtime: Awaited<ReturnType<typeof startServiceRuntime>> | undefined
  let stopping: Promise<void> | undefined
  const host = createChannel('host')
  const timeout = setTimeout(() => {
    host.close(new Error('SERVICE_START_TIMEOUT'))
    void shutdown(1)
  }, 30000)
  process.once('disconnect', () => {
    host.close(new Error('SERVICE_OWNER_DISCONNECTED'))
    void shutdown(1)
  })
  process.once('SIGTERM', () => {
    void shutdown(0)
  })
  process.once('SIGINT', () => {
    void shutdown(0)
  })
  process.on('message', (raw) => {
    try {
      const input = incomingSchema.parse(raw)
      if (input.type === 'rpc') {
        channels.get(input.channel)?.port.emit('message', { data: input.message })
      }
      else if (input.type === 'start') {
        if (started || stopping)
          throw new Error('SERVICE_ALREADY_STARTED')
        started = start(input.config)
        void started.catch(fail)
      }
      else if (input.type === 'connect') {
        connect(input.channel, input.role)
      }
      else {
        channels.get(input.channel)?.peer.close(new Error('SERVICE_CLIENT_DISCONNECTED'))
      }
    }
    catch (error) {
      fail(error)
    }
  })

  function send(message: unknown) {
    if (process.connected) {
      process.send!(message as object, (error) => {
        if (error)
          void shutdown(1)
      })
    }
  }

  function createChannel(id: string) {
    const port = Object.assign(new EventEmitter(), { postMessage: (message: unknown) => send({ type: 'rpc', channel: id, message }) })
    const peer = new BuddyServiceRpcServer({ recordDiagnostic: events.publish, port, onFatalError: () => {
      if (id === 'host')
        void shutdown(1)
    } })
    channelIds.add(id)
    channels.set(id, { port, peer })
    peer.onDidClose(() => {
      channels.delete(id)
    })
    return peer
  }

  async function start(config: z.infer<typeof nodeServiceConfigSchema>) {
    const builtinSkillsDirectories = await prepareNodeService(config)
    const preferences = structuredClone(config.preferences)
    const service = await startServiceRuntime({
      events,
      buddyHome: config.buddyHome,
      builtinSkillsDirectories,
      proxy: config.proxy,
      storageAuthority: config.storageAuthority,
      platform: createRpcRuntimePlatform(host, { display: config.display, preferences: { get: async () => structuredClone(preferences), subscribe: () => () => {} } }),
      notify: (method, params) => host.notify(method, params),
      onFatalFailure: fail,
    })
    runtime = service
    clearTimeout(timeout)
    if (!stopping)
      send({ type: 'ready', protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION })
    service.startMaintenance()
    return service
  }

  function connect(channel: string, role: ServiceClientRole) {
    if (!runtime || stopping || channelIds.has(channel)) {
      send({ type: 'rejected', channel, code: !runtime || stopping ? 'SERVICE_NOT_READY' : 'SERVICE_CHANNEL_EXISTS' })
      return
    }
    const peer = createChannel(channel)
    try {
      runtime.connectClient(role, peer)
      if (role === 'management') {
        registerServiceManagementRpc(peer, () => {
          void shutdown(0)
        }, runtime.prepareIdleShutdown)
      }
      notifyBuddyServiceReady(peer)
    }
    catch {
      peer.close(new Error('SERVICE_CLIENT_FAILED'))
      send({ type: 'rejected', channel, code: 'SERVICE_CLIENT_FAILED' })
    }
  }

  function fail(error: unknown) {
    const code = readBuddyServiceFailureCode(error)
    send({ type: 'failed', code })
    process.stderr.write(`Lexora Server failed: ${code} (${error instanceof Error ? error.name : 'unknown'})\n`)
    void shutdown(1)
  }

  function shutdown(code: number): Promise<void> {
    return stopping ??= (async () => {
      clearTimeout(timeout)
      const service = await started?.catch(() => undefined)
      try {
        await service?.dispose()
      }
      catch {
        code = 1
      }
      for (const { peer } of channels.values())
        peer.close(new Error('SERVICE_STOPPED'))
      process.exit(code)
    })()
  }
}
