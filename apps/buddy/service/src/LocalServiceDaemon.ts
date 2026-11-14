import type { serviceRuntimeStateSchema } from '../../shared/service/localServiceProtocol'
import type { startServiceRuntime } from './startServiceRuntime'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { currentPlatform } from '../../platform/currentPlatform'
import { localTransports } from '../../platform/ipc/localTransport'
import { createBuddyNativeEnvironment, resolveBuddyProcessControl } from '../../platform/native/nativeHost'
import { createProxyEnvironment } from '../../platform/process/proxyEnvironment'
import { HostConnection } from '../../platform/service/HostConnection'
import { LocalServiceServer } from '../../platform/service/LocalServiceServer'
import { ServiceChildProcess } from '../../platform/service/ServiceChildProcess'
import { readServiceLaunch } from '../../platform/service/serviceFiles'
import { ServiceProfileOwner } from '../../platform/service/ServiceProfileOwner'
import { ServiceRpcChannel } from '../../platform/service/ServiceRpcChannel'
import { ApplicationEvents } from '../../shared/observability/ApplicationEvents'
import { desktopOpenIntentSchema, platformHostReadySchema, serviceIdentitySchema, serviceMaintenanceTicketSchema, serviceStopReasonSchema } from '../../shared/service/localServiceProtocol'
import { createRpcRuntimePlatform } from './platform/createRpcRuntimePlatform'
import { prepareNodeService } from './platform/nodeServiceConfig'
import { startServiceRuntime as startRuntime } from './startServiceRuntime'
import { validateServiceRelease } from './validateServiceRelease'

type Runtime = Awaited<ReturnType<typeof startServiceRuntime>>
interface ServiceMaintenance {
  token: string
  hostId: string
  kind: 'backup' | 'restart'
  phase: 'stopping' | 'stopped' | 'resuming' | 'failed'
  pending?: Promise<unknown>
}

interface HostGeneration {
  id: string
  server: LocalServiceServer
  child: ServiceChildProcess
  peer?: ServiceRpcChannel
  intentional: boolean
  cancelReady: () => void
}

export async function startLocalServiceDaemon(path: string, options: { restartDesktop?: () => void } = {}) {
  const config = await readServiceLaunch(path)
  await validateServiceRelease(config)
  const nativePaths = { appPath: config.resourcesRoot, resourcesPath: config.resourcesRoot, isPackaged: true }
  const processControl = resolveBuddyProcessControl(nativePaths)
  const owner = await ServiceProfileOwner.acquire(config, processControl)
  const identity = serviceIdentitySchema.parse(serviceIdentitySchema.strip().parse(owner.discovery))
  const host = new HostConnection()
  const events = new ApplicationEvents()
  let runtime: Runtime | undefined
  let generation: HostGeneration | undefined
  let stopping: Promise<void> | undefined
  let recovering: Promise<void> | undefined
  let failures = 0
  let restartRequested = false
  let exitingHost: string | undefined
  let runtimeGeneration = randomUUID()
  let readyHost: z.infer<typeof platformHostReadySchema> | undefined
  let builtinSkillsDirectories: readonly string[] = []
  let maintenance: ServiceMaintenance | undefined
  const attachedClients = new Set<ServiceRpcChannel>()
  function publishRuntime(status: z.infer<typeof serviceRuntimeStateSchema>['status'], errorCode: string | null = null) {
    if (host.available)
      host.notify('service.runtimeState', { generation: runtimeGeneration, status, maintenance: maintenance?.kind === 'backup' ? 'backup' : null, errorCode })
  }
  async function createRuntime() {
    const value = await startRuntime({ buddyHome: join(config.profileRoot, 'buddy'), builtinSkillsDirectories, proxy: readyHost!.proxy, platform: createRpcRuntimePlatform(host), events, serviceInstanceId: runtimeGeneration, storageAuthority: config.storageAuthority, notify: (method, params) => {
      if (host.available)
        host.notify(method, params)
    }, onFatalFailure: (error) => {
      terminate(error)
    } })
    runtime = value
    value.startMaintenance()
    return value
  }
  async function requestStop(raw: unknown, fromHost = false) {
    const input = z.object({ expectedServiceInstanceId: z.literal(identity.serviceInstanceId), reason: serviceStopReasonSchema, commandId: z.uuid() }).strict().parse(raw)
    if (runtime?.commands) {
      const commands = runtime.commands
      const result = await commands.control.execute('runtime.stop', { dataGeneration: commands.identity.dataGeneration, expectedServiceInstanceId: commands.identity.serviceInstanceId, commandId: input.commandId, intent: { targetServiceInstanceId: commands.identity.serviceInstanceId, scope: 'stop_service' } })
      if (result.receipt.decision !== 'accepted')
        throw new Error('SERVICE_STOP_REJECTED')
      await commands.control.waitForEffects()
    }
    if (generation) {
      generation.intentional = true
      if (fromHost)
        exitingHost = generation.id
    }
    setImmediate(() => {
      void stop().catch(failed)
    })
    return { accepted: true }
  }
  host.onRequest('service.exitDesktop', raw => requestStop(raw, true))
  host.onRequest('service.restartDesktop', async (raw) => {
    z.object({ expectedServiceInstanceId: z.literal(identity.serviceInstanceId) }).strict().parse(raw)
    if (!options.restartDesktop || stopping || recovering || maintenance || owner.discovery.phase !== 'ready')
      throw new Error('SERVICE_NOT_READY')
    if (!restartRequested) {
      restartRequested = true
      setImmediate(() => options.restartDesktop!())
    }
    return { accepted: true }
  })
  host.onRequest('service.beginMaintenance', async (raw) => {
    const input = z.object({ expectedServiceInstanceId: z.literal(identity.serviceInstanceId), kind: z.enum(['backup', 'restart']) }).strict().parse(raw)
    if (stopping || recovering || maintenance || !runtime || owner.discovery.phase !== 'ready' || !host.instanceId)
      throw new Error('SERVICE_NOT_READY')
    if (input.kind === 'backup' && !runtime.prepareIdleShutdown())
      throw new Error('SNAPSHOT_RUNTIME_BUSY')
    const ticket: ServiceMaintenance = { token: randomUUID(), hostId: host.instanceId, kind: input.kind, phase: 'stopping' }
    maintenance = ticket
    const previous = runtime
    publishRuntime('stopping')
    for (const peer of attachedClients) peer.close(new Error('SERVICE_MAINTENANCE'))
    ticket.pending = (async () => {
      await owner.publish('maintenance')
      await previous.dispose()
      runtime = undefined
      ticket.phase = 'stopped'
      publishRuntime('stopped')
    })().catch((error) => {
      ticket.phase = 'failed'
      publishRuntime('offline', 'SERVICE_MAINTENANCE_FAILED')
      throw error
    })
    await ticket.pending
    return { token: ticket.token, generation: runtimeGeneration }
  })
  host.onRequest('service.endMaintenance', async (raw) => {
    const input = serviceMaintenanceTicketSchema.parse(raw)
    const ticket = maintenance
    if (!ticket || ticket.token !== input.token || runtimeGeneration !== input.generation || host.instanceId !== ticket.hostId || ticket.phase !== 'stopped' || stopping)
      throw new Error('SERVICE_MAINTENANCE_CHANGED')
    ticket.phase = 'resuming'
    runtimeGeneration = randomUUID()
    publishRuntime('starting')
    ticket.pending = (async () => {
      await createRuntime()
      if (stopping || host.instanceId !== ticket.hostId)
        throw new Error('SERVICE_MAINTENANCE_CHANGED')
      maintenance = undefined
      await owner.publish('ready')
      publishRuntime('ready')
    })().catch((error) => {
      maintenance = ticket
      ticket.phase = 'failed'
      publishRuntime('offline', 'SERVICE_MAINTENANCE_FAILED')
      throw error
    })
    await ticket.pending
    return { generation: runtimeGeneration }
  })
  let resolveRuntime!: (runtime: Runtime) => void
  let rejectRuntime!: (error: unknown) => void
  const available = new Promise<Runtime>((resolve, reject) => {
    resolveRuntime = resolve

    rejectRuntime = reject
  })
  void available.catch(() => {})
  const management = new LocalServiceServer({
    endpoint: endpoint(owner.discovery.managementEndpoint),
    identity,
    role: 'management',
    secret: owner.managementSecret,
    connected(frames) {
      const peer = new ServiceRpcChannel(frames)
      peer.onRequest('service.status', (raw) => {
        z.object({}).strict().parse(raw)
        return owner.discovery
      })
      let attached = false
      peer.onRequest('service.attachDesktop', async (raw, signal) => {
        if (attached)
          throw new Error('SERVICE_CLIENT_ALREADY_ATTACHED')
        attached = true
        z.object({ expectedServiceInstanceId: z.literal(identity.serviceInstanceId) }).strict().parse(raw)
        if (stopping || recovering || maintenance)
          throw new Error('SERVICE_NOT_READY')
        const service = runtime ?? await available
        signal?.throwIfAborted()
        if (stopping || peer.closed || service !== runtime || maintenance)
          throw new Error('SERVICE_NOT_READY')
        attachedClients.add(peer)
        peer.onDidClose(() => attachedClients.delete(peer))
        service.connectClient('product', peer)
        service.connectClient('management', peer)
        return { serviceInstanceId: identity.serviceInstanceId, pid: process.pid, generation: runtimeGeneration }
      })
      peer.onRequest('service.openDesktop', async (raw, signal) => {
        const input = z.object({ expectedServiceInstanceId: z.literal(identity.serviceInstanceId), intent: desktopOpenIntentSchema }).strict().parse(raw)
        if (owner.discovery.phase !== 'ready' || !generation?.peer)
          throw new Error('SERVICE_NOT_READY')
        return generation.peer.request('host.openDesktop', input.intent, 25000, signal)
      })
      peer.onRequest('service.stop', async (raw) => {
        return requestStop(raw)
      })
    },
  })
  const product = new LocalServiceServer({
    endpoint: endpoint(owner.discovery.productEndpoint),
    identity,
    role: 'product',
    secret: owner.productSecret,
    connected(frames, connectionId) {
      if (!runtime || stopping || owner.discovery.phase !== 'ready')
        throw new Error('SERVICE_NOT_READY')
      const connection = runtime.createLocalProductConnection({ connectionId, send: frame => frames.send(frame), close: () => frames.close(), assertCurrent: () => {
        if (stopping)
          throw new Error('SERVICE_STOPPING')
      } })
      frames.onFrame((frame) => {
        void connection.receive(frame)
      })
      frames.onDidClose(() => connection.close())
    },
  })
  function endpoint(address: string) {
    return localTransports[currentPlatform.transport](address, { ownsProfileLease: () => true })
  }
  function reportFailure(error: unknown) {
    process.stderr.write(`Lexora service unavailable: ${error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_FAILED'}\n`)
  }
  function failed(error: unknown) {
    reportFailure(error)
    void owner.publish('failed').catch(() => {})
  }
  function terminate(error: unknown) {
    reportFailure(error)
    void stop().then(() => {
      process.exitCode = 1
    }).catch(failed)
  }
  async function launchHost() {
    if (stopping)
      throw new Error('SERVICE_STOPPING')
    const id = randomUUID()
    const secret = randomBytes(32).toString('hex')
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\lexora-${id}-host` : join(dirname(owner.discovery.managementEndpoint), `${id.slice(0, 8)}-host.sock`)
    let accept!: (value: z.infer<typeof platformHostReadySchema>) => void
    let reject!: (reason: unknown) => void
    const ready = new Promise<z.infer<typeof platformHostReadySchema>>((resolve, fail) => {
      accept = resolve

      reject = fail
    })
    void ready.catch(() => {})
    const timeout = setTimeout(() => reject(new Error('PLATFORM_HOST_READINESS_TIMEOUT')), 120000)
    let current: HostGeneration | undefined
    const server = new LocalServiceServer({ endpoint: endpoint(address), identity, role: 'host', secret, singleUse: true, connected(frames) {
      const peer = new ServiceRpcChannel(frames)
      if (!current)
        throw new Error('PLATFORM_HOST_CHANGED')
      current.peer = peer
      host.attach(id, peer)
      peer.onRequest('host.ready', (raw) => {
        const input = platformHostReadySchema.parse(raw)
        if (input.hostInstanceId !== id)
          throw new Error('PLATFORM_HOST_CHANGED')
        accept(input)
        return { accepted: true }
      })
      const connected = current
      peer.onDidClose(() => {
        reject(new Error('PLATFORM_HOST_UNAVAILABLE'))
        lost(connected)
      })
    } })
    try {
      await server.listen()
      if (stopping)
        throw new Error('SERVICE_STOPPING')
      const child = new ServiceChildProcess({ executable: config.hostExecutable, args: [...config.hostArguments, '--lexora-platform-host'], processControl, runtimeGuard: createBuddyNativeEnvironment(nativePaths).LEXORA_BUDDY_RUNTIME_GUARD, env: { ...process.env, ...createBuddyNativeEnvironment(nativePaths), LEXORA_HOME: config.defaultRoot ?? config.profileRoot, LEXORA_BUDDY_PROFILE: config.profile, LEXORA_BUDDY_STORAGE_AUTHORITY: config.storageAuthority }, output: (_stream, value) => process.stderr.write(value) })
      current = { id, server, child, intentional: false, cancelReady: () => reject(new Error('SERVICE_STOPPING')) }
      generation = current
      void child.exited.then(() => {
        reject(new Error('PLATFORM_HOST_EXITED'))

        lost(current!)
      }, reject)
      await child.ready({ version: 1, identity, profile: config.profile, profileRoot: config.profileRoot, resourcesRoot: config.resourcesRoot, endpoint: address, managementEndpoint: owner.discovery.managementEndpoint, managementSecret: owner.managementSecret, hostInstanceId: id, secret })
      return await ready
    }
    catch (error) {
      if (current) {
        current.intentional = true
        host.detach(id)
        await current.child.stopAndVerify()
      }
      await server.dispose()
      if (generation === current)
        generation = undefined
      throw error
    }
    finally {
      clearTimeout(timeout)
    }
  }
  function lost(current: HostGeneration) {
    if (current.intentional || current !== generation || stopping)
      return
    current.intentional = true
    host.detach(current.id)
    if (recovering)
      return
    if (maintenance) {
      maintenance.phase = 'failed'
      terminate(new Error('PLATFORM_HOST_UNAVAILABLE'))
      return
    }
    if (!runtime)
      return
    recovering = Promise.resolve().then(async () => {
      await owner.publish('recovering')
      updateProxy('http://127.0.0.1:0')
      const suspended = runtime!.suspendPlatform('PLATFORM_HOST_UNAVAILABLE')
      void suspended.catch(() => {})
      await current.child.stopAndVerify()
      await current.server.dispose()
      generation = undefined
      await suspended
      while (failures < 3) {
        if (stopping)
          return
        failures++
        let ready: z.infer<typeof platformHostReadySchema>
        try {
          ready = await launchHost()
        }
        catch (error) {
          if (generation)
            throw error
          continue
        }
        if (stopping)
          return
        readyHost = ready
        updateProxy(ready.proxy.httpProxy)
        await runtime!.resumePlatform(ready.proxy)
        if (host.instanceId !== ready.hostInstanceId)
          throw new Error('PLATFORM_HOST_UNAVAILABLE')
        if (stopping)
          return
        await owner.publish('ready')
        if (host.instanceId !== ready.hostInstanceId)
          throw new Error('PLATFORM_HOST_UNAVAILABLE')
        publishRuntime('ready')
        return
      }
      if (!stopping)
        throw new Error('PLATFORM_HOST_RECOVERY_EXHAUSTED')
    }).catch(terminate).finally(() => {
      recovering = undefined
    })
  }
  async function stop(): Promise<void> {
    return stopping ??= (async () => {
      const errors: unknown[] = []
      const phase = async (operation: () => Promise<unknown>, milliseconds: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('SERVICE_STOP_PHASE_TIMEOUT')), milliseconds)
          })])
        }
        catch (error) {
          errors.push(error)
        }
        finally {
          clearTimeout(timer)
        }
      }
      generation?.cancelReady()
      await owner.publish('stopping')
      await phase(() => product.dispose(), 2000)
      await phase(async () => recovering, 15000)
      await phase(async () => maintenance?.pending, 30000)
      await phase(async () => runtime?.dispose(), 20000)
      if (!errors.length && host.available)
        host.notify('service.executionStopped', {})
      if (generation) {
        generation.intentional = true
        const current = generation
        await phase(async () => {
          if (exitingHost === current.id)
            await current.child.exited
          else if (current.peer && !current.peer.closed)
            await current.peer.request('host.stop', {}, 10000)
        }, exitingHost === current.id ? 20000 : 11000)
        await phase(() => current.child.stopAndVerify(), 12000)
        host.detach(current.id)
        await phase(() => current.server.dispose(), 2000)
      }
      host.close(new Error('SERVICE_STOPPED'))
      if (errors.length) {
        await owner.publish('failed')
        throw new AggregateError(errors, 'SERVICE_STOP_UNCONFIRMED')
      }
      await management.dispose()
      await owner.dispose()
    })()
  }
  try {
    await management.listen()
    const ready = await launchHost()
    updateProxy(ready.proxy.httpProxy)
    readyHost = ready
    builtinSkillsDirectories = await prepareNodeService({ profile: config.profile, buddyHome: join(config.profileRoot, 'buddy'), resourcesRoot: config.resourcesRoot, preferences: ready.preferences, proxy: ready.proxy, display: ready.display, storageAuthority: config.storageAuthority })
    await createRuntime()
    if (host.instanceId !== ready.hostInstanceId)
      throw new Error('PLATFORM_HOST_UNAVAILABLE')
    resolveRuntime(runtime!)
    await product.listen()
    await owner.publish('ready')
    publishRuntime('ready')
    return { config, discovery: owner.discovery, stop, openDesktop: () => generation!.peer!.request('host.openDesktop', { kind: 'tasks' }, 25000) }
  }
  catch (error) {
    rejectRuntime(error)
    await stop().catch(failed)
    throw error
  }
}

function updateProxy(url: string): void {
  for (const key of Object.keys(process.env)) {
    if (/^(?:https?|all|no)_proxy$/i.test(key))
      delete process.env[key]
  }
  Object.assign(process.env, createProxyEnvironment(url), { NODE_USE_ENV_PROXY: '1' })
}
