import type { Api, Credential, Model, OAuthCredential } from '@earendil-works/pi-ai'
import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBuddyDatabase } from '../../storage/database'
import { createProviderService } from '../createProviderService'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  databases.splice(0).forEach(database => database.close())
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const agentDirectory = await mkdtemp(join(tmpdir(), 'buddy-discovery-'))
  directories.push(agentDirectory)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const credentials = new Map<string, Credential>()
  const peer: RuntimeRpcPeerContract = {
    notify: () => {},
    onNotification: () => () => {},
    onRequest: () => () => {},
    close: () => {},
    request: async (method, params) => {
      const { providerId, credential } = params as { providerId: string, credential: Credential }
      if (method === 'host.credentials.list')
        return { ok: true, providers: [...credentials].map(([providerId, value]) => ({ providerId, type: value.type })) }
      if (method === 'host.credentials.read')
        return { ok: true, value: credentials.get(providerId) ?? null }
      if (method === 'host.credentials.write')
        credentials.set(providerId, credential)
      else if (method === 'host.credentials.delete')
        credentials.delete(providerId)
      else
        throw new Error(`Unexpected host request: ${method}`)
      return { ok: true }
    },
  }
  return {
    credentials,
    setup: () => createProviderService({ agentDirectory, database, peer }),
    cache: () => readFile(join(agentDirectory, 'models-store.json'), 'utf8'),
  }
}

function oauth(account: string): OAuthCredential {
  const payload = { 'sub': `${account}-user`, 'https://api.openai.com/auth': { chatgpt_account_id: account } }
  return {
    type: 'oauth',
    access: `fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`,
    refresh: 'fixture-refresh-token',
    expires: Date.now() + 3_600_000,
    accountId: account,
  }
}

describe('built-in model discovery through the production runtime', () => {
  it.each([
    { providerId: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    { providerId: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
    { providerId: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
    { providerId: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' },
  ] as const)('refreshes $providerId for legacy and new instances, preserving independent state and offline execution', async ({ providerId, api, baseUrl }) => {
    const remote: Model<Api> = {
      id: 'fixture-new-model',
      name: 'New model',
      provider: providerId,
      api,
      baseUrl,
      contextWindow: 192_000,
      maxTokens: 32_000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: { off: null, high: 'high' },
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }
    let contextWindow = remote.contextWindow
    let status = 200
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit) => {
      const url = new URL(input)
      expect(`${url.origin}${url.pathname}`).toBe(`https://pi.dev/api/models/providers/${providerId}`)
      expect(url.searchParams.get('types')).toBe('chat,image,classifier')
      expect(new Headers(init.headers).has('authorization')).toBe(false)
      if (status !== 200)
        return new Response(null, { status })
      const models: unknown[] = [{ ...remote, contextWindow }]
      if (providerId === 'openrouter')
        models.push({ id: remote.id, name: 'Image model', type: 'image', api: 'openrouter-images', provider: providerId, baseUrl, input: ['text'], output: ['image'], cost: remote.cost })
      return Response.json(models, { headers: { 'last-modified': 'Fri, 01 Jan 2100 00:00:00 GMT' } })
    })
    const harness = await fixture()
    harness.credentials.set(providerId, providerId === 'openai-codex' ? oauth('account-a') : { type: 'api_key', key: 'fixture-key' })
    const service = await harness.setup()
    const other = await service.addProvider(providerId)
    harness.credentials.set(other.id, providerId === 'openai-codex' ? oauth('account-b') : { type: 'api_key', key: 'fixture-other-key' })
    for (const id of [providerId, other.id]) {
      expect(await service.listModels(id)).not.toContainEqual(expect.objectContaining({ id: remote.id }))
      expect(await service.syncModels(id)).toContainEqual(expect.objectContaining({
        id: remote.id,
        enabled: false,
        available: true,
        contextWindow: 192_000,
        capabilities: ['text', 'image', 'reasoning'],
      }))
    }
    await service.setModelEnabled(providerId, remote.id, true)
    await service.setProviderEnabled(providerId, true)
    await service.setModelParametersOverride(providerId, remote.id, { contextWindow: 64_000, maxTokens: 8000 })
    await service.setDefaultModel({ providerId, modelId: remote.id, reasoning: 'high' })
    contextWindow = 224_000
    await service.syncModels(other.id)
    const runtime = service.executionModels.getRuntime()
    expect(runtime.getModels(providerId).find(model => model.id === remote.id)?.contextWindow).toBe(192_000)
    expect(runtime.getModels(other.id).find(model => model.id === remote.id)?.contextWindow).toBe(224_000)
    const before = await service.listModels(providerId)
    status = 503
    await expect(service.syncModels(providerId)).rejects.toMatchObject({ code: 'MODEL_SYNC_FAILED' })
    expect(await service.listModels(providerId)).toEqual(before)
    const cache = await harness.cache()
    expect(cache).not.toContain('fixture-key')
    expect(cache).not.toContain(oauth('account-a').access)
    vi.stubGlobal('fetch', () => {
      throw new Error('offline')
    })
    const restored = await harness.setup()
    expect(await restored.listModels(providerId)).toContainEqual(expect.objectContaining({
      id: remote.id,
      enabled: true,
      available: true,
      contextWindow: 64_000,
      maxTokens: 8000,
      sourceContextWindow: 192_000,
    }))
    expect(await restored.getDefaultModel()).toMatchObject({ providerId, modelId: remote.id })
    const resolved = await restored.executionModels.resolveAvailable({ providerId, modelId: remote.id, contextWindow: null, maxTokens: null })
    expect(resolved).toMatchObject({ id: remote.id, api, contextWindow: 64_000, input: ['text', 'image'] })
    if (providerId === 'openrouter') {
      const runtime = restored.executionModels.getRuntime()
      expect(runtime.getModelOfType('image', other.id, remote.id)).toMatchObject({ type: 'image', provider: other.id, id: remote.id })
      expect(runtime.getModels(other.id).filter(model => model.id === remote.id)).toHaveLength(1)
    }
  })
})
