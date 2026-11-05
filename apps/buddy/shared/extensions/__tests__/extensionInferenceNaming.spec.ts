import { expect, it } from 'vitest'
import { inferenceContributionSchema } from '../extensionInference'

const contribution = {
  runtimes: [{ id: 'local', entry: 'native/local.mjs', platforms: ['linux-x64'] }],
  capabilities: [{ id: 'chat', title: 'Chat', kind: 'chat.completion', runtime: 'local' }],
}

it('accepts an optional bounded service name independently of the plugin name', () => {
  expect(inferenceContributionSchema.parse(contribution).providerName).toBeUndefined()
  expect(inferenceContributionSchema.parse({ ...contribution, providerName: '  Example Local  ' }).providerName).toBe('Example Local')
  expect(inferenceContributionSchema.parse({ ...contribution, providerName: 'x'.repeat(100) }).providerName).toHaveLength(100)
  for (const providerName of ['', ' \t\n', 'x'.repeat(101), null])
    expect(inferenceContributionSchema.safeParse({ ...contribution, providerName }).success).toBe(false)
})
