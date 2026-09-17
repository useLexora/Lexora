import searchTools from '../../../apps/buddy/platform/native/searchTools.json' with { type: 'json' }
import shellSandbox from '../../../apps/buddy/platform/native/shellSandbox.json' with { type: 'json' }
import definitions from '../../../apps/buddy/shared/platform/definitions.json' with { type: 'json' }
import { CPU_ARCHITECTURE, OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { nativeHostResources } from './native-host.mjs'

const featureResources = {
  nativePet: [
    { from: '.output/build/native/release/lexora-buddy-pet', to: 'native-pet/lexora-buddy-pet' },
    { from: 'service/resources/skills/lexora-buddy-animation', to: 'service/resources/skills/lexora-buddy-animation' },
  ],
  systemActions: [],
}

export function platformResources(target) {
  return [
    ...nativeHostResources(target).map(({ from, to }) => ({ from, to })),
    { from: `${searchTools.resource.from}/${target.id}`, to: searchTools.resource.to },
    ...(target.platform === OPERATING_SYSTEM.Linux ? [{ from: `${shellSandbox.resource.from}/${target.id}`, to: shellSandbox.resource.to }] : []),
    ...target.features.flatMap(id => featureResources[id]),
  ]
}

export function platformSkills(target) {
  return target.features.flatMap(id => definitions.features[id].skills)
}

export function excludedPlatformResources(target) {
  return Object.entries(featureResources)
    .filter(([id]) => !target.features.includes(id))
    .flatMap(([, resources]) => resources)
}

export function excludedDependencyFiles(target) {
  const tuiNative = 'node_modules/@earendil-works/pi-tui/native'
  const sandboxVendor = 'node_modules/@anthropic-ai/sandbox-runtime/vendor'
  return [
    '!node_modules/@mariozechner/clipboard-darwin-universal/**',
    ...[OPERATING_SYSTEM.MacOS, OPERATING_SYSTEM.Windows].flatMap(platform => platform !== target.platform
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
