import type { InferenceEnvironment, InferencePlatform, InferenceRuntime } from './extensionInference.ts'
import type { ExtensionManifest } from './extensionManifest.ts'
import { CPU_ARCHITECTURE, OPERATING_SYSTEM } from '../platform/identifiers.ts'

export function resolveInferenceEnvironment(platform: string, architecture: string): InferenceEnvironment {
  if (architecture === CPU_ARCHITECTURE.X64) {
    if (platform === OPERATING_SYSTEM.Linux)
      return { platform: 'linux-x64', executionMode: 'isolated' }
    if (platform === OPERATING_SYSTEM.Windows)
      return { platform: 'windows-x64', executionMode: 'supervised' }
  }
  if (platform === OPERATING_SYSTEM.MacOS && architecture === CPU_ARCHITECTURE.ARM64)
    return { platform: 'macos-arm64', executionMode: 'supervised' }
  return { platform: null, executionMode: 'unsupported' }
}

export function supervisedInferencePlatforms(contribution: ExtensionManifest['contributes']['inference']): InferencePlatform[] {
  const platforms = new Set([
    ...(contribution?.preparation?.platforms ?? []),
    ...(contribution?.runtimes.flatMap(runtime => runtime.platforms) ?? []),
  ])
  return (['windows-x64', 'macos-arm64'] as const).filter(platform => platforms.has(platform))
}

export function supportsInferenceRuntime(runtime: Pick<InferenceRuntime, 'platforms'>, platform: string, architecture: string): boolean {
  const environment = resolveInferenceEnvironment(platform, architecture)
  return environment.platform !== null && runtime.platforms.includes(environment.platform)
}
