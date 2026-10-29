import type { ExtensionInspection } from '../../../shared/extensions/extensionAuthoring'
import type { SpeechProvider } from '../../../shared/speech/speechApi'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { BrowserIntegration } from '../browser/BrowserIntegration'
import type { registerExtensionIpc } from '../extensions/registerExtensionIpc'
import type { DesktopFeature } from '../platform/desktopFeatures'
import type { CredentialVault } from '../secrets/CredentialVault'
import type { DesktopWindowHost } from './DesktopWindowHost'
import type { DesktopEnvironment } from './typing'
import { join } from 'node:path'
import process from 'node:process'
import { app, powerMonitor } from 'electron'
import { currentPlatform } from '../../../platform/currentPlatform'
import { createBuddyNativeEnvironment, resolveBuddyProcessControl, resolveBuddyShellSandbox } from '../../../platform/native/nativeHost'
import shellSandbox from '../../../platform/native/shellSandbox.json'
import { checkSandboxEnvironment } from '../../../platform/process/sandboxDependencies'
import { setupWindowsSandbox } from '../../../platform/process/windowsSandbox'
import { currentTarget } from '../../../platform/target'
import { resolveWindowsPowerShell } from '../../../platform/windows/powerShell'
import { automationNotifications } from '../../../shared/automation/automationApi'
import { contextPanelRpc, contextPanelSourceSchema } from '../../../shared/context-panel/contextPanel'
import { extensionAgentInvocationSchema, extensionAgentRpc } from '../../../shared/extensions/extensionAgent'
import { extensionAgentResourceRequestSchema } from '../../../shared/extensions/extensionAgentResources'
import { extensionCapabilitiesRpc } from '../../../shared/extensions/extensionCapabilities'
import { extensionSkillsRpc } from '../../../shared/extensions/extensionSkills'
import { networkPermissionGrantSchema, networkPermissionsRpc } from '../../../shared/permissions/networkPermissionsRpc'
import { isLinux } from '../../../shared/platform/identifiers'
import { runtimePreferencesRpc } from '../../../shared/runtime/runtimePreferences'
import { HOST_SPEECH_MODELS } from '../../../shared/speech/speechApi'
import { installAttachmentProtocol } from '../attachmentProtocol'
import { registerBrowserHostRpc } from '../browser/registerBrowserHostRpc'
import { initializeDesktopConfig } from '../config/initializeDesktopConfig'
import { LexoraConfigStore } from '../config/LexoraConfigStore'
import { ContextPanelHost } from '../context-panel/ContextPanelHost'
import { DesktopPerformanceMonitor } from '../diagnostics/DesktopPerformanceMonitor'
import { registerExtensionAuthoringRpc } from '../extensions/registerExtensionAuthoringRpc'
import { registerExtensionShellRpc } from '../extensions/registerExtensionShellRpc'
import { DesktopNetwork } from '../network/DesktopNetwork'
import { HostWebService } from '../network/HostWebService'
import { registerWebHostRpc } from '../network/registerWebHostRpc'
import { createDesktopFeatures } from '../platform/desktopFeatures'
import { installRendererProtocol } from '../rendererProtocol'
import { createBuddyServiceEnvironment, resolveBuddySearchToolsDirectory } from '../runtime/buddyServiceEnvironment'
import { forkBuddyServiceProcess } from '../runtime/buddyServiceProcess'
import { BuddyServiceSupervisor } from '../runtime/BuddyServiceSupervisor'
import { registerSandboxHostRpc } from '../sandbox/registerSandboxHostRpc'
import { verifySandboxInstallation } from '../sandbox/verifySandboxInstallation'
import { createCredentialVault } from '../secrets/CredentialVault'
import { registerCredentialHostRpc } from '../secrets/registerCredentialHostRpc'

export class DesktopRuntimeHost {
  readonly performance: DesktopPerformanceMonitor
  inspectExtension: ((id: string) => Promise<ExtensionInspection>) | null = null
  extensionAgent: ReturnType<typeof registerExtensionIpc>['agent'] | null = null
  extensionShells: ReturnType<typeof registerExtensionIpc>['shells'] | null = null
  extensionSkills: ReturnType<typeof registerExtensionIpc>['skills'] | null = null
  extensionCapabilities: ReturnType<typeof registerExtensionIpc>['capabilities'] | null = null
  extensionStorage: Pick<ReturnType<typeof registerExtensionIpc>, 'withStoppedStorage'> | null = null
  readonly contextPanel: ContextPanelHost
  readonly configStore: LexoraConfigStore
  readonly #environment: DesktopEnvironment
  readonly #windows: DesktopWindowHost
  readonly #browser: BrowserIntegration
  #credentials: CredentialVault | null = null
  #config: LexoraConfig | null = null
  #features: DesktopFeature[] = []
  #service: BuddyServiceSupervisor | null = null
  #network: DesktopNetwork | null = null
  #webHost: HostWebService | null = null
  #windowsPowerShell: string | undefined
  readonly #subscriptions: Array<() => void> = []
  #prepareSandbox: (() => void) | undefined
  readonly #sandboxCleanup = new Set<Promise<void>>()
  #sandboxCheck: ReturnType<typeof checkSandboxEnvironment> | null = null
  #sandboxSetup: ReturnType<typeof setupWindowsSandbox> | null = null

  constructor(environment: DesktopEnvironment, windows: DesktopWindowHost, browser: BrowserIntegration) {
    this.#environment = environment
    this.#windows = windows
    this.#browser = browser
    this.performance = new DesktopPerformanceMonitor(() => ({ metrics: app.getAppMetrics(), proxy: this.network.activity }), environment.events.publish)
    this.configStore = new LexoraConfigStore({ configPath: environment.paths.configPath })
    const configDiagnostics = this.configStore.onDidChange(change => environment.events.publish({ event: `settings.${change.kind.replaceAll('-', '_')}`, component: 'desktop.settings', level: change.kind.endsWith('failed') ? 'warn' : 'info', revision: change.revision, operationId: change.operationId, count: change.groups.length }))
    this.#subscriptions.push(() => configDiagnostics.dispose())
    this.contextPanel = new ContextPanelHost(async (operation) => {
      await this.service.request(contextPanelRpc.recordOperation, operation)
    })
    const panelDiagnostics = this.contextPanel.onDidChange(change => environment.events.publish({ event: change.kind === 'record' ? `context_panel.record.${change.status}` : `context_panel.${change.state.open ? 'opened' : 'closed'}`, component: 'desktop.context_panel', level: change.kind === 'record' && change.status === 'failed' ? 'warn' : 'info', operationId: change.operationId, revision: change.revision }))
    this.#subscriptions.push(() => panelDiagnostics.dispose())
  }

  get config(): LexoraConfig | null {
    return this.#config
  }

  withStoppedStorage<T>(operation: () => Promise<T>): Promise<T> {
    const stopped = () => this.service.withStoppedStorage(operation)
    return this.extensionStorage ? this.extensionStorage.withStoppedStorage(stopped) : stopped()
  }

  get language(): LexoraConfig['desktop']['language'] {
    return this.#config?.desktop.language ?? 'zh-CN'
  }

  get network(): DesktopNetwork {
    if (!this.#network)
      throw new Error('Desktop network is not prepared')
    return this.#network
  }

  get windowsPowerShell(): string | undefined {
    return this.#windowsPowerShell
  }

  getSandboxStatus(): ReturnType<typeof checkSandboxEnvironment> {
    this.#sandboxCheck ??= checkSandboxEnvironment(this.#sandboxOptions()).finally(() => {
      this.#sandboxCheck = null
    })
    return this.#sandboxCheck
  }

  async verifyInstallation(): Promise<void> {
    if (!this.#environment.isSmokeTest)
      throw new Error('Installation verification requires an isolated smoke launch')
    await verifySandboxInstallation({ ...this.#sandboxOptions(), buddyHome: this.#environment.paths.buddyHome })
  }

  setupSandbox(): ReturnType<typeof setupWindowsSandbox> {
    this.#sandboxSetup ??= setupWindowsSandbox(this.#sandboxExecutable()).then((result) => {
      if (result === 'ready')
        this.#prepareSandbox?.()
      return result
    }).finally(() => {
      this.#sandboxSetup = null
      this.#sandboxCheck = null
    })
    return this.#sandboxSetup
  }

  #sandboxExecutable(): string | undefined {
    return resolveBuddyShellSandbox({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath })
  }

  #sandboxOptions() {
    return {
      searchDirectory: resolveBuddySearchToolsDirectory({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
      sandboxDirectory: isLinux(currentTarget.platform)
        ? join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? shellSandbox.resource.to : `${shellSandbox.resource.from}/${currentTarget.id}`)
        : undefined,
      windowsSandbox: this.#sandboxExecutable(),
      receiptDirectory: join(this.#environment.paths.buddyHome, 'process-receipts'),
      windowsShell: this.#windowsPowerShell,
      processControl: resolveBuddyProcessControl({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    }
  }

  get service(): BuddyServiceSupervisor {
    if (!this.#service)
      throw new Error('Desktop Runtime is not prepared')
    return this.#service
  }

  async prepare(): Promise<LexoraConfig> {
    const environment = this.#environment
    const nativePaths = {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }
    const credentials = createCredentialVault({ buddyHome: environment.paths.buddyHome, reportDiagnostic: environment.events.publish })
    this.#credentials = credentials
    const config = await initializeDesktopConfig(this.configStore, {
      configPath: environment.paths.configPath,
      buddyHome: environment.paths.buddyHome,
      languages: app.getPreferredSystemLanguages(),
    })
    this.#config = config
    this.#network = new DesktopNetwork()
    const networkDiagnostics = this.#network.onDidChange(change => environment.events.publish({ event: `network.${change.kind}.${change.status}`, component: 'desktop.network', level: ['failed', 'degraded', 'unavailable'].includes(change.status) ? 'warn' : 'info', operationId: change.operationId, revision: change.revision, ...(change.failure ? { failure: change.failure, errorCode: 'NETWORK_START_FAILED' } : {}) }))
    this.#subscriptions.push(() => networkDiagnostics.dispose())
    await this.#network.start(config.proxy)
    this.#webHost = new HostWebService({
      authenticateProxy: this.#network.authenticateProxy,
      assertAvailable: this.#network.assertAvailable,
      report: fact => environment.events.publish({
        event: `web.resource.${fact.kind}.${fact.phase.replaceAll('-', '_')}`,
        component: 'desktop.web',
        webResource: fact,
        level: fact.code ? 'warn' : 'info',
        requestId: fact.requestId,
        operationId: fact.operationId,
        durationMs: fact.durationMs,
        count: fact.phase === 'queued' ? fact.queued : fact.active,
        ...(fact.code ? { errorCode: fact.code } : {}),
      }),
    })
    this.#windowsPowerShell = currentPlatform.shell === 'powershell'
      ? await resolveWindowsPowerShell()
      : undefined
    const composition = createDesktopFeatures(currentPlatform, {
      ...nativePaths,
      diagnostics: environment.diagnostics,
      report: event => environment.events.publish(event),
      onOpenDesktop: () => this.#windows.show(),
      paths: environment.paths,
    })
    this.#features = composition.features
    this.#service = new BuddyServiceSupervisor({
      onDiagnostic: (event) => {
        environment.diagnostics.record({ ...event, scope: 'local-service' })
      },
      bindPeer: (peer) => {
        const sandbox = registerSandboxHostRpc(peer, {
          buddyHome: environment.paths.buddyHome,
          protectedRoots: environment.storage.protection.sandboxRoots,
          protectionScope: environment.storage.bootstrapRoot,
          proxyUrl: this.#network!.sandboxProxyUrl,
          ...this.#sandboxOptions(),
        })
        const prepareSandbox = () => {
          sandbox.prepare()
          peer.notify('host.sandbox.ready', {})
        }
        this.#prepareSandbox = prepareSandbox
        sandbox.onDidChange(event => environment.events.publish({
          event: `sandbox.supervisor.${event.kind}`,
          level: event.kind === 'cleanup_failed' ? 'warn' : 'info',
          requestId: event.requestId,
          sandboxProcess: { phase: event.kind, pid: event.pid, exitCode: event.exitCode },
        }))
        const stopAuthoring = registerExtensionAuthoringRpc(peer, (id) => {
          if (!this.inspectExtension)
            throw new Error('EXTENSION_SERVICE_UNAVAILABLE')
          return this.inspectExtension(id)
        }, () => this.#config?.desktop.pluginAuthor ?? '')
        const disposers = [
          peer.onRequest(HOST_SPEECH_MODELS, () => this.speechModels?.() ?? []),
          registerExtensionShellRpc(peer, () => this.extensionShells),
          peer.onRequest(extensionAgentRpc.list, () => this.extensionAgent?.list() ?? []),
          peer.onRequest(extensionSkillsRpc.list, () => this.extensionSkills?.list() ?? []),
          peer.onRequest(extensionAgentRpc.resource, (input, signal) => {
            if (!this.extensionAgent)
              throw new Error('EXTENSION_AGENT_UNAVAILABLE')
            return this.extensionAgent.readResource(extensionAgentResourceRequestSchema.parse(input), signal ?? new AbortController().signal)
          }),
          // Unlike skills, an empty answer here would read as "everything was uninstalled", so an unready service must fail instead.
          peer.onRequest(extensionCapabilitiesRpc.list, () => {
            if (!this.extensionCapabilities)
              throw new Error('EXTENSION_SERVICE_UNAVAILABLE')
            return this.extensionCapabilities.list()
          }),
          peer.onRequest(extensionAgentRpc.invoke, (input, signal) => {
            if (!this.extensionAgent)
              throw new Error('EXTENSION_AGENT_UNAVAILABLE')
            return this.extensionAgent.invoke(extensionAgentInvocationSchema.parse(input), signal ?? new AbortController().signal)
          }),
          peer.onRequest(runtimePreferencesRpc.get, () => this.#config!.runtime),
          peer.onRequest(networkPermissionsRpc.get, async () => (await this.configStore.read()).browser.networkPermissions),
          peer.onRequest(networkPermissionsRpc.allow, async (params, signal) => {
            const input = networkPermissionGrantSchema.parse(params)
            await this.configStore.allowNetworkPermission(input.host, input.operation, () => signal?.throwIfAborted())
            return {}
          }),
          peer.onRequest(contextPanelRpc.presentBrowser, (params) => {
            const source = contextPanelSourceSchema.parse(params)
            return this.contextPanel.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
          }),
          registerWebHostRpc(peer, this.#webHost!),
          registerBrowserHostRpc(peer, {
            createAdapterLease: input => this.#browser.adapter.issueLease(input),
            getHost: () => this.#browser.host,
          }),
          registerCredentialHostRpc(peer, credentials),
          ...this.#features.map(feature => feature.bindPeer(peer)),
        ]
        return () => {
          if (this.#prepareSandbox === prepareSandbox)
            this.#prepareSandbox = undefined
          const cleanup = Promise.allSettled([sandbox.dispose(), stopAuthoring()]).then((results) => {
            const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
            if (failures.length)
              throw new AggregateError(failures, 'RUNTIME_CLEANUP_FAILED')
          }).finally(() => this.#sandboxCleanup.delete(cleanup))
          this.#sandboxCleanup.add(cleanup)
          disposers.forEach(dispose => dispose())
        }
      },
      diagnosticOutput: environment.diagnostics.createWritable('local-service', { event: 'runtime.supervisor', level: 'error' }),
      spawnService: (onFatalError, sourceId) => forkBuddyServiceProcess({
        env: {
          ...createBuddyServiceEnvironment(process.env, environment.paths.buddyHome, process.platform, this.#network!.proxyUrl, environment.storage.protection),
          ...createBuddyNativeEnvironment(nativePaths),
          ...(this.#windowsPowerShell ? { PI_POWERSHELL_PATH: this.#windowsPowerShell } : {}),
          PI_TOOLS_DIR: resolveBuddySearchToolsDirectory(nativePaths),
          LEXORA_BUDDY_SKILLS_DIRS: JSON.stringify(composition.builtinSkillsDirectories),
        },
        onFatalError,
        captureStderr: output => environment.diagnostics.captureOutput('local-service', output, sourceId),
      }),
    })
    this.#subscriptions.push(environment.startup.bindRuntime(this.#service))
    return config
  }

  async applyConfig(config: LexoraConfig): Promise<void> {
    await this.#network?.apply(config.proxy)
    const previous = this.#config?.runtime
    this.#config = config
    if (previous?.cacheWarming !== config.runtime.cacheWarming || previous?.codemode !== config.runtime.codemode || previous?.modelRetryLimit !== config.runtime.modelRetryLimit)
      this.#service?.notify(runtimePreferencesRpc.changed, config.runtime)
    const featureConfig = config.desktop.onboardingCompleted ? config : { ...config, pet: { ...config.pet, enabled: false } }
    await Promise.all(this.#features.map(feature => feature.applyConfig(featureConfig)))
    if (app.isPackaged && this.#environment.paths.profile === 'stable')
      await this.#environment.setAutostart(config.desktop.launchAtLogin)
  }

  start(): void {
    const service = this.service
    const wakeOnResume = () => {
      this.#environment.events.publish({ event: 'system.resumed', level: 'info' })
      service.notify(automationNotifications.wake.method, { reason: 'resume' })
    }
    const wakeOnUnlock = () => {
      this.#environment.events.publish({ event: 'system.unlocked', level: 'info' })
      service.notify(automationNotifications.wake.method, { reason: 'unlock-screen' })
    }
    const onSuspend = () => this.#environment.events.publish({ event: 'system.suspended', level: 'info' })
    powerMonitor.on('suspend', onSuspend)
    powerMonitor.on('resume', wakeOnResume)
    powerMonitor.on('unlock-screen', wakeOnUnlock)
    this.#subscriptions.push(() => {
      powerMonitor.off('suspend', onSuspend)
      powerMonitor.off('resume', wakeOnResume)
      powerMonitor.off('unlock-screen', wakeOnUnlock)
    })
    service.start()
    this.performance.start()
    this.#subscriptions.push(installAttachmentProtocol(service))
    this.#subscriptions.push(installRendererProtocol())
  }

  speechModels: (() => Promise<SpeechProvider[]>) | undefined

  readProviderCredential(providerId: string): Promise<unknown> {
    if (!this.#credentials)
      throw new Error('Desktop credential vault is not prepared')
    return this.#credentials.read('providers', providerId)
  }

  readWebCredential(): Promise<unknown> {
    if (!this.#credentials)
      throw new Error('Desktop credential vault is not prepared')
    return this.#credentials.read('web', 'tavily')
  }

  async stop(): Promise<void> {
    this.performance.stop()
    const failures: unknown[] = []
    for (const cleanup of [
      () => this.contextPanel.dispose(),
      () => this.configStore.dispose(),
      () => this.#service?.stop(),
      () => Promise.all(this.#sandboxCleanup),
      () => this.#webHost?.dispose(),
      () => this.#network?.stop(),
      ...this.#features.map(feature => () => feature.stop()),
      ...this.#subscriptions.splice(0),
    ]) {
      try {
        await cleanup()
      }
      catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Desktop runtime cleanup failed')
  }
}
