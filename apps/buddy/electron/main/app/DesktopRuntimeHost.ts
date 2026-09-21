import type { LexoraConfig } from '../../shared/desktopApi'
import type { BrowserIntegration } from '../browser/BrowserIntegration'
import type { DesktopFeature } from '../platform/desktopFeatures'
import type { CredentialVault } from '../secrets/CredentialVault'
import type { DesktopWindowHost } from './DesktopWindowHost'
import type { DesktopEnvironment } from './typing'
import { join } from 'node:path'
import process from 'node:process'
import { app, powerMonitor } from 'electron'
import { currentPlatform } from '../../../platform/currentPlatform'
import { createBuddyNativeEnvironment, resolveBuddyShellSandbox } from '../../../platform/native/nativeHost'
import shellSandbox from '../../../platform/native/shellSandbox.json'
import { checkSandboxEnvironment } from '../../../platform/process/sandboxDependencies'
import { setupWindowsSandbox } from '../../../platform/process/windowsSandbox'
import { currentTarget } from '../../../platform/target'
import { resolveWindowsPowerShell } from '../../../platform/windows/powerShell'
import { automationNotifications } from '../../../shared/automation/automationApi'
import { contextPanelRpc, contextPanelSourceSchema } from '../../../shared/context-panel/contextPanel'
import { isLinux } from '../../../shared/platform/identifiers'
import { runtimePreferencesRpc } from '../../../shared/runtime/runtimePreferences'
import { installAttachmentProtocol } from '../attachmentProtocol'
import { registerBrowserHostRpc } from '../browser/registerBrowserHostRpc'
import { LexoraConfigStore } from '../config/LexoraConfigStore'
import { ContextPanelHost } from '../context-panel/ContextPanelHost'
import { registerExtensionAuthoringRpc } from '../extensions/registerExtensionAuthoringRpc'
import { DesktopNetwork } from '../network/DesktopNetwork'
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
  #windowsPowerShell: string | undefined
  readonly #subscriptions: Array<() => void> = []
  #sandboxCheck: ReturnType<typeof checkSandboxEnvironment> | null = null
  #sandboxSetup: ReturnType<typeof setupWindowsSandbox> | null = null

  constructor(environment: DesktopEnvironment, windows: DesktopWindowHost, browser: BrowserIntegration) {
    this.#environment = environment
    this.#windows = windows
    this.#browser = browser
    this.configStore = new LexoraConfigStore({ configPath: environment.paths.configPath })
    this.contextPanel = new ContextPanelHost(async (operation) => {
      try {
        await this.service.request(contextPanelRpc.recordOperation, operation)
      }
      catch (error) {
        environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'context_panel.record.failed', error })
      }
    })
  }

  get config(): LexoraConfig | null {
    return this.#config
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
    this.#sandboxSetup ??= setupWindowsSandbox(this.#sandboxExecutable()).finally(() => {
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
      windowsShell: this.#windowsPowerShell,
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
    const credentials = createCredentialVault({ buddyHome: environment.paths.buddyHome })
    this.#credentials = credentials
    const config = await this.configStore.read()
    this.#config = config
    this.#network = new DesktopNetwork()
    await this.#network.start(config.proxy)
    this.#windowsPowerShell = currentPlatform.shell === 'powershell'
      ? await resolveWindowsPowerShell()
      : undefined
    const composition = createDesktopFeatures(currentPlatform, {
      ...nativePaths,
      diagnostics: environment.diagnostics,
      onOpenDesktop: () => this.#windows.show(),
      paths: environment.paths,
    })
    this.#features = composition.features
    this.#service = new BuddyServiceSupervisor({
      onDiagnostic: (event) => {
        environment.diagnostics.record({ ...event, scope: 'local-service' })
        environment.startup.observe(event, event)
      },
      bindPeer: (peer) => {
        const disposers = [
          peer.onRequest(runtimePreferencesRpc.get, () => this.#config!.runtime),
          registerExtensionAuthoringRpc(peer),
          peer.onRequest(contextPanelRpc.presentBrowser, (params) => {
            const source = contextPanelSourceSchema.parse(params)
            return this.contextPanel.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
          }),
          registerWebHostRpc(peer, this.#network!.authenticateProxy),
          registerSandboxHostRpc(peer, {
            buddyHome: environment.paths.buddyHome,
            proxyUrl: this.#network!.sandboxProxyUrl,
            ...this.#sandboxOptions(),
          }),
          registerBrowserHostRpc(peer, {
            createAdapterLease: input => this.#browser.adapter.issueLease(input),
            getHost: () => this.#browser.host,
          }),
          registerCredentialHostRpc(peer, credentials),
          ...this.#features.map(feature => feature.bindPeer(peer)),
        ]
        return () => disposers.forEach(dispose => dispose())
      },
      diagnosticOutput: environment.diagnostics.createWritable('local-service', { event: 'runtime.supervisor', level: 'error' }),
      spawnService: (onFatalError, sourceId) => forkBuddyServiceProcess({
        env: {
          ...createBuddyServiceEnvironment(process.env, environment.paths.buddyHome, process.platform, this.#network!.proxyUrl),
          ...createBuddyNativeEnvironment(nativePaths),
          ...(this.#windowsPowerShell ? { PI_POWERSHELL_PATH: this.#windowsPowerShell } : {}),
          PI_TOOLS_DIR: resolveBuddySearchToolsDirectory(nativePaths),
          LEXORA_BUDDY_SKILLS_DIRS: JSON.stringify(composition.builtinSkillsDirectories),
        },
        onFatalError,
        captureStderr: output => environment.diagnostics.captureOutput('local-service', output, sourceId),
      }),
    })
    return config
  }

  async applyConfig(config: LexoraConfig): Promise<void> {
    await this.#network?.apply(config.proxy)
    const previous = this.#config?.runtime
    this.#config = config
    if (previous?.cacheWarming !== config.runtime.cacheWarming)
      this.#service?.notify(runtimePreferencesRpc.changed, config.runtime)
    await Promise.all(this.#features.map(feature => feature.applyConfig(config)))
    if (app.isPackaged && !this.#environment.isSmokeTest)
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
    this.#subscriptions.push(installAttachmentProtocol(service))
    this.#subscriptions.push(installRendererProtocol())
  }

  readWebCredential(): Promise<unknown> {
    if (!this.#credentials)
      throw new Error('Desktop credential vault is not prepared')
    return this.#credentials.read('web', 'tavily')
  }

  async stop(): Promise<void> {
    const failures: unknown[] = []
    for (const cleanup of [
      () => this.#service?.stop(),
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
