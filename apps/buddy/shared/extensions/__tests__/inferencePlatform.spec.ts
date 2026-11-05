import { expect, it } from 'vitest'
import { inferenceContributionSchema, inferenceRuntimeSchema } from '../extensionInference'
import { resolveInferenceEnvironment, supervisedInferencePlatforms, supportsInferenceRuntime } from '../inferencePlatform'

it('distinguishes Windows and macOS supervision from Linux isolation and unsupported targets', () => {
  expect(resolveInferenceEnvironment('linux', 'x64')).toEqual({ platform: 'linux-x64', executionMode: 'isolated' })
  expect(resolveInferenceEnvironment('win32', 'x64')).toEqual({ platform: 'windows-x64', executionMode: 'supervised' })
  expect(resolveInferenceEnvironment('darwin', 'arm64')).toEqual({ platform: 'macos-arm64', executionMode: 'supervised' })
  for (const [platform, architecture] of [['linux', 'arm64'], ['win32', 'arm64'], ['darwin', 'x64'], ['windows', 'x64']])
    expect(resolveInferenceEnvironment(platform!, architecture!)).toEqual({ platform: null, executionMode: 'unsupported' })
})

it('validates unique supported runtime targets and respects each runtime declaration', () => {
  const runtime = { id: 'chat', entry: 'native/chat.mjs', platforms: ['linux-x64', 'windows-x64', 'macos-arm64'] }
  const accepted = inferenceRuntimeSchema.parse(runtime)
  expect(supportsInferenceRuntime(accepted, 'win32', 'x64')).toBe(true)
  expect(supportsInferenceRuntime(accepted, 'darwin', 'arm64')).toBe(true)
  expect(supportsInferenceRuntime({ platforms: ['linux-x64', 'windows-x64'] }, 'darwin', 'arm64')).toBe(false)
  expect(supportsInferenceRuntime({ platforms: ['linux-x64'] }, 'win32', 'x64')).toBe(false)
  expect(supportsInferenceRuntime(accepted, 'win32', 'arm64')).toBe(false)
  for (const platforms of [[], ['linux-x64', 'linux-x64'], ['win32-x64'], ['windows-arm64'], ['darwin-arm64'], ['macos-x64']])
    expect(inferenceRuntimeSchema.safeParse({ ...runtime, platforms }).success).toBe(false)
})

it('collects supervised execution targets from both runtimes and preparation without duplicates', () => {
  const contribution = inferenceContributionSchema.parse({
    preparation: { entry: 'native/prepare.mjs', platforms: ['macos-arm64'] },
    runtimes: [{ id: 'chat', entry: 'native/chat.mjs', platforms: ['linux-x64', 'windows-x64'] }],
    capabilities: [{ id: 'chat', title: 'Chat', kind: 'chat.completion', runtime: 'chat' }],
  })
  expect(supervisedInferencePlatforms(contribution)).toEqual(['windows-x64', 'macos-arm64'])
  contribution.runtimes[0]!.platforms.push('macos-arm64')
  expect(supervisedInferencePlatforms(contribution)).toEqual(['windows-x64', 'macos-arm64'])
  expect(supervisedInferencePlatforms(undefined)).toEqual([])
})
