import shellSandbox from '../../../apps/buddy/platform/native/shellSandbox.json' with { type: 'json' }
import definitions from '../../../apps/buddy/shared/platform/definitions.json' with { type: 'json' }
import { CPU_ARCHITECTURE, OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'

export function desktopHostResources(target) {
  return [
    ...(target.platform === OPERATING_SYSTEM.Linux ? [{ from: `${shellSandbox.resource.from}/${target.id}`, to: shellSandbox.resource.to }] : []),
    ...(target.features.includes('nativePet') ? [{ from: '.output/build/native/release/lexora-buddy-pet', to: 'native-pet/lexora-buddy-pet' }] : []),
  ]
}

export function platformSkills(target) {
  return [...definitions.skills, ...target.features.flatMap(id => definitions.features[id].skills)]
}

export function excludedDependencyFiles(target) {
  const tuiNative = 'node_modules/@earendil-works/pi-tui/native'
  const sandboxVendor = 'node_modules/@anthropic-ai/sandbox-runtime/vendor'
  return [
    ...Object.values(OPERATING_SYSTEM).flatMap(platform => platform !== target.platform
      ? [`!${tuiNative}/${platform}/**`]
      : Object.values(CPU_ARCHITECTURE)
          .filter(architecture => architecture !== target.architecture)
          .map(architecture => `!${tuiNative}/${platform}/prebuilds/${platform}-${architecture}/**`)),
    ...(target.platform !== OPERATING_SYSTEM.Linux
      ? [`!${sandboxVendor}/**`]
      : Object.values(CPU_ARCHITECTURE)
          .filter(architecture => architecture !== target.architecture)
          .map(architecture => `!${sandboxVendor}/seccomp/${architecture}/**`)),
  ]
}
