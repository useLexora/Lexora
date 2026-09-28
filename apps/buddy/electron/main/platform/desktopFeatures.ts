import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { BuddyFeatureId, BuddyPlatform } from '../../../shared/platform'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { DesktopDiagnosticLogger } from '../desktopDiagnostics'
import type { BuddyRuntimePaths } from '../paths'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { BUDDY_BUILTIN_SKILLS, BUDDY_FEATURES } from '../../../shared/platform'
import { reloadNativePetConfig } from '../pet/nativePetControlSocket'
import { createNativePetProcessFactory, NativePetSupervisor } from '../pet/NativePetSupervisor'
import { registerPetHostRpc } from '../pet/registerPetHostRpc'

export interface DesktopFeature {
  bindPeer: (peer: RuntimeRpcPeerContract) => () => void
  applyConfig: (config: LexoraConfig) => Promise<void>
  stop: () => Promise<void>
}

interface DesktopFeatureContext {
  appPath: string
  diagnostics: DesktopDiagnosticLogger
  report?: ApplicationDiagnosticReporter
  isPackaged: boolean
  onOpenDesktop: () => void
  paths: BuddyRuntimePaths
  resourcesPath: string
}

const desktopFeatureFactories: Partial<Record<BuddyFeatureId, (context: DesktopFeatureContext) => DesktopFeature>> = {
  nativePet: createNativePetFeature,
}

export function createDesktopFeatures(platform: BuddyPlatform, context: DesktopFeatureContext) {
  const features = platform.features.flatMap((id) => {
    const factory = desktopFeatureFactories[id]
    return factory ? [factory(context)] : []
  })
  const resourceRoot = context.isPackaged ? context.resourcesPath : context.appPath
  return {
    features,
    builtinSkillsDirectories: [...BUDDY_BUILTIN_SKILLS, ...platform.features.flatMap(id => BUDDY_FEATURES[id].skills)]
      .map(name => join(resourceRoot, 'service', 'resources', 'skills', name)),
  }
}

function createNativePetFeature(context: DesktopFeatureContext): DesktopFeature {
  if (!context.paths.nativePetSocket || !context.paths.nativePetState)
    throw new Error('Native pet contribution is missing its runtime paths')
  for (const path of [context.paths.nativePetSocket, context.paths.nativePetState])
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const environment = {
    ...process.env,
    LEXORA_BUDDY_PET_SOCKET: context.paths.nativePetSocket,
    LEXORA_BUDDY_PET_STATE_PATH: context.paths.nativePetState,
    LEXORA_HOME: context.paths.lexoraHome,
  }
  const supervisor = new NativePetSupervisor({
    diagnosticOutput: context.diagnostics.createWritable('native-pet', { event: 'pet.supervisor', level: 'error' }),
    captureStderr: output => context.diagnostics.captureOutput('native-pet', output),
    onOpenDesktop: context.onOpenDesktop,
    spawnPet: createNativePetProcessFactory({
      appPath: context.appPath,
      env: environment,
      isPackaged: context.isPackaged,
      petPathOverride: process.env.LEXORA_BUDDY_PET_PATH,
      resourcesPath: context.resourcesPath,
    }),
  })
  const diagnostics = supervisor.onDidChange((change) => {
    const status = change.kind === 'state' ? change.state.status : change.status
    context.report?.({ event: `pet.${change.kind}.${status.replaceAll('-', '_')}`, component: 'desktop.pet', level: ['failed', 'unknown', 'spawn-failed', 'stop-unknown', 'offline'].includes(status) ? 'warn' : 'info', revision: change.revision, ...(change.generation ? { generation: change.generation } : {}), ...('operationId' in change ? { operationId: change.operationId } : {}), ...('completedSteps' in change && change.status !== 'unknown' ? { count: change.completedSteps } : {}) })
  })
  async function reloadExistingPet(): Promise<boolean> {
    try {
      return await reloadNativePetConfig(environment)
    }
    catch (error) {
      context.diagnostics.record({ scope: 'native-pet', level: 'warn', event: 'pet.config_reload_failed', error })
      return false
    }
  }
  return {
    bindPeer: peer => registerPetHostRpc(peer, supervisor),
    async applyConfig(config) {
      if (!config.pet.enabled) {
        await reloadExistingPet()
        await supervisor.stop()
        return
      }
      if (!supervisor.reloadConfig() && !(await reloadExistingPet()))
        supervisor.start()
    },
    async stop() {
      try {
        await supervisor.dispose()
      }
      finally {
        diagnostics.dispose()
      }
    },
  }
}
