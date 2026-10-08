import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { describe, expect, it } from 'vitest'
import { clearAmbientProviderCredentials } from '../providerEnvironment'

describe('provider credential isolation', () => {
  it('prevents ambient workload identity from configuring Anthropic', async () => {
    const identity = {
      ANTHROPIC_FEDERATION_RULE_ID: 'fixture-rule',
      ANTHROPIC_ORGANIZATION_ID: 'fixture-org',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/fixture/identity-token',
      ANTHROPIC_SERVICE_ACCOUNT_ID: 'fixture-account',
      ANTHROPIC_WORKSPACE_ID: 'fixture-workspace',
    }
    const provider = anthropicProvider()
    const environment: NodeJS.ProcessEnv = { ...identity, PATH: '/fixture/bin' }
    const options = {
      ctx: { env: async (name: string) => environment[name], fileExists: async () => false },
      signal: new AbortController().signal,
    }
    expect(await provider.auth.apiKey!.resolve(options)).toMatchObject({ source: 'workload identity federation' })
    clearAmbientProviderCredentials(environment)
    expect(environment).toEqual({ PATH: '/fixture/bin' })
    expect(await provider.auth.apiKey!.resolve(options)).toBeUndefined()
    expect(await provider.auth.apiKey!.resolve({ ...options, credential: { type: 'api_key', key: 'fixture-managed-key' } }))
      .toMatchObject({ auth: { apiKey: 'fixture-managed-key' }, source: 'stored credential' })
  })
})
