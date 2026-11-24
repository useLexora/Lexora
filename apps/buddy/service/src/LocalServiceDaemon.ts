import type { ApplicationDiagnostic } from '../../shared/diagnostics/applicationDiagnostic'
import type { DesktopOpenIntent, ServiceLaunch, serviceRuntimeStateSchema } from '../../shared/service/localServiceProtocol'
import type { startServiceRuntime } from './startServiceRuntime'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join, win32 } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { currentPlatform } from '../../platform/currentPlatform'
import { localTransports } from '../../platform/ipc/localTransport'
import { createBuddyNativeEnvironment, resolveBuddyProcessControl } from '../../platform/native/nativeHost'
import { createProxyEnvironment } from '../../platform/process/proxyEnvironment'
import { HostConnection } from '../../platform/service/HostConnection'
import { LocalServiceServer } from '../../platform/service/LocalServiceServer'
import { createPrivateStartupRecord } from '../../platform/service/privateStartupRecord'
import { ServiceChildProcess } from '../../platform/service/ServiceChildProcess'
import { ServiceProfileOwner } from '../../platform/service/ServiceProfileOwner'
import { ServiceRpcChannel } from '../../platform/service/ServiceRpcChannel'
import { measureServiceStartupStep } from '../../platform/service/serviceStartupStep'
import { writePlatformHostDiagnostic } from '../../platform/service/writePlatformHostDiagnostic'
import { validateWindowsFilePath } from '../../platform/windows/filePath'
import { APPLICATION_DIAGNOSTIC_METHOD, safeDiagnosticReporter } from '../../shared/diagnostics/applicationDiagnostic'
import { ApplicationEvents } from '../../shared/observability/ApplicationEvents'
import { desktopOpenIntentSchema, platformHostReadySchema, serviceIdentitySchema, serviceMaintenanceTicketSchema, serviceStopReasonSchema } from '../../shared/service/localServiceProtocol'
import { writeServiceStderr } from './writeServiceStderr'

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

export class CancelledServiceStartup extends Error {
  constructor() { super('SERVICE_STOPPING') }
}

export async function startLocalServiceDaemon(config: ServiceLaunch, options: { restartDesktop?: () => void, foreground?: boolean, signal?: AbortSignal, parentOperationId?: string, startupSteps?: readonly ApplicationDiagnostic[] } = {}) {
  const nativePaths = { serviceResourcesRoot: config.resourcesRoot }
  const processControl = resolveBuddyProcessControl(nativePaths)
  const owner = await ServiceProfileOwner.acquire(config, processControl)
  const recordStartup = createPrivateStartupRecord(join(config.profileRoot, '.runtime'), 'core', config.buildId)
  let hostBoundary: 'core_management' | 'host_spawn' | 'host_bootstrap' | 'host_handshake' = 'core_management'
  let initialHostPid: number | undefined
  let hostEvidenceWrite: Promise<void> | undefined
  function hostEvidence(outcome: 'pending' | 'ready' | 'failed' | 'cancelled' | 'timeout') {
    hostEvidenceWrite = recordStartup(hostBoundary, outcome, { hostPid: initialHostPid })
  }
  const identity = serviceIdentitySchema.parse(serviceIdentitySchema.strip().parse(owner.discovery))
  const host = new HostConnection()
  const events = new ApplicationEvents()
  const parent = options.parentOperationId ?? randomUUID()
  const loadModules = () => measureServiceStartupStep('runtime.module_load', parent, () => import('./localServiceRuntime'))
  const localChecks = new AbortController()
  const checkResources = () => measureServiceStartupStep('runtime.node_resources', parent, async () => {
    const { inspectNodeServiceResources } = await import('./platform/nodeServiceConfig')
    return inspectNodeServiceResources({ profile: config.profile, buddyHome: join(config.profileRoot, 'buddy'), resourcesRoot: config.resourcesRoot }, localChecks.signal)
  })
  let resources: ReturnType<typeof checkResources>
  const cancelStartup = Promise.withResolvers<never>()
  void cancelStartup.promise.catch(() => {})
  let modules: ReturnType<typeof loadModules>
  let runtime: Runtime | undefined
  let generation: HostGeneration | undefined
  let startup: Promise<void>
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
  const platformReady = Promise.withResolvers<void>()
  const desktopRequests = new AbortController()
  void platformReady.promise.catch(() => {})
  function publishRuntime(status: z.infer<typeof serviceRuntimeStateSchema>['status'], errorCode: string | null = null) {
    if (host.available)
      host.notify('service.runtimeState', { generation: runtimeGeneration, status, maintenance: maintenance?.kind === 'backup' ? 'backup' : null, errorCode })
  }
  function assertCurrentHost(ready: z.infer<typeof platformHostReadySchema>) {
    if (stopping)
      throw new Error('SERVICE_STOPPING')
    if (generation?.intentional || host.instanceId !== ready.hostInstanceId)
      throw new Error('PLATFORM_HOST_UNAVAILABLE')
  }
  function bindReadyHost(ready: z.infer<typeof platformHostReadySchema>) {
    assertCurrentHost(ready)
    if (currentPlatform.shell === 'powershell') {
      process.env.PI_POWERSHELL_PATH = hostPowerShell(ready.windowsPowerShell)
    }
    readyHost = ready
    updateProxy(ready.proxy.httpProxy)
  }
  async function createRuntime() {
    const { value: { startServiceRuntime, createRpcRuntimePlatform } } = await modules
    assertCurrentHost(readyHost!)
    const value = await startServiceRuntime({ buddyHome: join(config.profileRoot, 'buddy'), builtinSkillsDirectories, proxy: readyHost!.proxy, platform: createRpcRuntimePlatform(host), events, serviceInstanceId: runtimeGeneration, storageAuthority: config.storageAuthority, forceEventRecovery: process.env.LEXORA_BUDDY_EVENT_RECOVERY === 'full', notify: (method, params) => {
      if (host.available)
        host.notify(method, params)
    }, onFatalFailure: (error) => {
      terminate(error)
    } })
    runtime = value
    if (stopping)
      throw new Error('SERVICE_STOPPING')
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
    desktopRequests.abort()
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
  async function openDesktop(intent: DesktopOpenIntent, signal?: AbortSignal) {
    const allowStarting = intent.kind === 'tasks' && !intent.conversationId
    const requestSignal = signal ? AbortSignal.any([signal, desktopRequests.signal]) : desktopRequests.signal
    try {
      if (owner.discovery.phase === 'starting' && allowStarting)
        await platformReady.promise
      requestSignal.throwIfAborted()
      const phase = owner.discovery.phase
      if (stopping || !generation?.peer || (phase !== 'ready' && !(allowStarting && phase === 'starting')))
        throw new Error('SERVICE_NOT_READY')
      return await generation.peer.request('host.openDesktop', intent, 25000, requestSignal)
    }
    catch (error) {
      if (desktopRequests.signal.aborted)
        return { accepted: false, uiReady: false, targetVisible: false, visible: false, focused: false }
      throw error
    }
  }
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
        peer.onDidClose((rpcDisconnect) => {
          attachedClients.delete(peer)
          if (!stopping && !maintenance && !recovering && !generation?.intentional)
            events.publish({ event: 'management.connection_closed', component: 'runtime.management', level: 'warn', generation: runtimeGeneration, rpcDisconnect })
        })
        service.connectClient('product', peer)
        service.connectClient('management', peer)
        return { serviceInstanceId: identity.serviceInstanceId, pid: process.pid, generation: runtimeGeneration }
      })
      peer.onRequest('service.openDesktop', async (raw, signal) => {
        const input = z.object({ expectedServiceInstanceId: z.literal(identity.serviceInstanceId), intent: desktopOpenIntentSchema }).strict().parse(raw)
        return openDesktop(input.intent, signal)
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
    writeServiceStderr(`Lexora service unavailable: ${error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_FAILED'}\n`)
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
  async function launchHost(afterBootstrap?: () => Promise<unknown>) {
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
      if (stopping || !current || current !== generation || current.intentional)
        throw new Error('PLATFORM_HOST_CHANGED')
      const peer = new ServiceRpcChannel(frames)
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
      peer.onDidClose((rpcDisconnect) => {
        if (!connected.intentional && connected === generation && !stopping) {
          writePlatformHostDiagnostic({
            event: 'platform_host.connection_closed',
            level: 'warn',
            component: 'runtime.platform_host',
            generation: connected.id,
            hostPid: connected.child.child.pid,
            rpcDisconnect,
          })
        }
        host.detach(id)
        reject(new Error('PLATFORM_HOST_UNAVAILABLE'))
        lost(connected)
      })
    } })
    try {
      await server.listen()
      if (stopping)
        throw new Error('SERVICE_STOPPING')
      const child = new ServiceChildProcess({ executable: config.hostExecutable, args: [...config.hostArguments, '--lexora-platform-host'], processControl, runtimeGuard: createBuddyNativeEnvironment(nativePaths).LEXORA_BUDDY_RUNTIME_GUARD, env: { ...process.env, ...createBuddyNativeEnvironment(nativePaths), LEXORA_HOME: config.defaultRoot ?? config.profileRoot, LEXORA_BUDDY_PROFILE: config.profile, LEXORA_BUDDY_STORAGE_AUTHORITY: config.storageAuthority }, output: (_stream, value) => writeServiceStderr(value) })
      const launched = { id, server, child, intentional: false, cancelReady: () => reject(new Error('SERVICE_STOPPING')) }
      current = launched
      generation = launched
      if (afterBootstrap) {
        initialHostPid = child.child.pid
        hostBoundary = 'host_bootstrap'
        hostEvidence('pending')
      }
      void child.exited.then((exit) => {
        writePlatformHostDiagnostic({
          event: 'platform_host.process_exited',
          level: launched.intentional || stopping ? 'info' : 'warn',
          component: 'runtime.platform_host',
          generation: id,
          hostPid: child.child.pid,
          exit,
        })
        reject(new Error('PLATFORM_HOST_EXITED'))

        lost(launched)
      }, reject)
      await child.ready({ version: 1, identity, profile: config.profile, profileRoot: config.profileRoot, resourcesRoot: config.resourcesRoot, endpoint: address, managementEndpoint: owner.discovery.managementEndpoint, managementSecret: owner.managementSecret, hostInstanceId: id, secret })
      if (stopping)
        throw new Error('SERVICE_STOPPING')
      if (launched.intentional)
        throw new Error('PLATFORM_HOST_UNAVAILABLE')
      if (afterBootstrap) {
        hostBoundary = 'host_handshake'
        hostEvidence('pending')
        void afterBootstrap().catch(reject)
      }
      const input = await ready
      bindReadyHost(input)
      return input
    }
    catch (error) {
      if (afterBootstrap)
        hostEvidence(stopping ? 'cancelled' : error instanceof Error && error.message === 'PLATFORM_HOST_READINESS_TIMEOUT' ? 'timeout' : 'failed')
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
    if (!runtime) {
      localChecks.abort(new Error('PLATFORM_HOST_UNAVAILABLE'))
      return
    }
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
        assertCurrentHost(ready)
        await runtime!.resumePlatform(ready.proxy)
        if (host.instanceId !== ready.hostInstanceId)
          throw new Error('PLATFORM_HOST_UNAVAILABLE')
        if (stopping)
          return
        await owner.publish('ready')
        if (host.instanceId !== ready.hostInstanceId)
          throw new Error('PLATFORM_HOST_UNAVAILABLE')
        publishRuntime('ready')
        writePlatformHostDiagnostic({ event: 'platform_host.recovered', level: 'info', component: 'runtime.platform_host', generation: ready.hostInstanceId, previousGeneration: current.id, attempt: failures })
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
      desktopRequests.abort()
      localChecks.abort(new Error('SERVICE_STOPPING'))
      cancelStartup.reject(new Error('SERVICE_STOPPING'))
      generation?.cancelReady()
      await phase(() => Promise.allSettled([startup, resources]), 20000)
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
      await hostEvidenceWrite
      await owner.dispose()
    })()
  }
  startup = (async () => {
    hostEvidence('pending')
    try {
      await management.listen()
      await owner.publish('starting')
    }
    catch (error) {
      hostEvidence(stopping ? 'cancelled' : 'failed')
      throw error
    }
    hostBoundary = 'host_spawn'
    hostEvidence('pending')
    const { value: ready, record: handshake } = await measureServiceStartupStep('runtime.host_handshake', parent, () => launchHost(() => {
      resources = checkResources()
      modules = loadModules()
      return Promise.all([resources, modules])
    }))
    hostEvidence('ready')
    const reportStartup = safeDiagnosticReporter(event => host.notify(APPLICATION_DIAGNOSTIC_METHOD, event))
    options.startupSteps?.forEach(reportStartup)
    reportStartup(handshake)
    assertCurrentHost(ready)
    publishRuntime('starting')
    platformReady.resolve()
    if (options.foreground)
      void openDesktop({ kind: 'tasks' }).catch(() => {})
    const { record: admission } = await measureServiceStartupStep('runtime.product_ready', parent, async () => {
      const [local, loaded] = await Promise.race([Promise.all([resources, modules]), cancelStartup.promise])
      reportStartup(local.record)
      reportStartup(loaded.record)
      assertCurrentHost(ready)
      const environment = await measureServiceStartupStep('runtime.node_environment', parent, () => loaded.value.activateNodeService(local.value))
      builtinSkillsDirectories = environment.value
      reportStartup(environment.record)
      if (stopping)
        throw new Error('SERVICE_STOPPING')
      await createRuntime()
      if (host.instanceId !== ready.hostInstanceId)
        throw new Error('PLATFORM_HOST_UNAVAILABLE')
      if (stopping)
        throw new Error('SERVICE_STOPPING')
      resolveRuntime(runtime!)
      await product.listen()
      if (stopping)
        throw new Error('SERVICE_STOPPING')
      await owner.publish('ready')
    })
    reportStartup(admission)
    if (!stopping)
      publishRuntime('ready')
  })()
  const onAbort = () => {
    void stop().catch(failed)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted)
    onAbort()
  try {
    await startup
    return { config, discovery: owner.discovery, stop }
  }
  catch (error) {
    const cancelled = stopping && error instanceof Error && error.message === 'SERVICE_STOPPING'
    platformReady.reject(error)
    rejectRuntime(error)
    await stop().catch((failure) => {
      failed(failure)
      throw failure
    })
    if (cancelled)
      throw new CancelledServiceStartup()
    throw error
  }
  finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

function hostPowerShell(path: string | undefined): string {
  try {
    const executable = validateWindowsFilePath(path ?? '')
    if (['pwsh.exe', 'powershell.exe'].includes(win32.basename(executable).toLowerCase()))
      return executable
  }
  catch {}
  throw new Error('PLATFORM_HOST_SHELL_INVALID')
}

function updateProxy(url: string): void {
  for (const key of Object.keys(process.env)) {
    if (/^(?:https?|all|no)_proxy$/i.test(key))
      delete process.env[key]
  }
  Object.assign(process.env, createProxyEnvironment(url), { NODE_USE_ENV_PROXY: '1' })
}
