import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { expect, it, vi } from 'vitest'
import { EXTENSION_CAPABILITIES_RPC, EXTENSION_IDENTITY_RPC, extensionCapabilitiesSchema, extensionIdentitySchema } from '../../../../shared/extensions/extensionAuthoring'
import { EXTENSION_API_VERSION, extensionPlacementSchema } from '../../../../shared/extensions/extensionManifest'
import { registerExtensionAuthoringRpc } from '../registerExtensionAuthoringRpc'

vi.mock('../compileExtension', () => ({ compileExtension: () => {
  throw new Error('Unexpected compilation')
} }))

it('discovers a compact host index and exact target contracts without loading plugins', async () => {
  const handlers = new Map<string, RuntimeRequestHandler>()
  const dispose = registerExtensionAuthoringRpc({ onRequest: (method, handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  } }, async () => { throw new Error('Unexpected inspection') }, () => '')
  try {
    const query = (params: unknown) => Promise.resolve(handlers.get(EXTENSION_CAPABILITIES_RPC)!(params))
    const index = extensionCapabilitiesSchema.parse(await query({}))
    expect(index.apiVersion).toBe(EXTENSION_API_VERSION)
    expect(index.targets.some(target => target.target === 'composer.accessory' && target.scope === 'composer')).toBe(true)
    expect(index.targets.every(target => !target.description && !target.height)).toBe(true)
    const detail = extensionCapabilitiesSchema.parse(await query({ target: 'composer.accessory' }))
    expect(detail.targets).toEqual([expect.objectContaining({ kind: 'slot', selection: 'multiple', height: { min: 32, max: 240, default: 64 } })])
    const placement = { id: 'tests.content.slot', view: 'tests.content.view', kind: 'slot', target: detail.targets[0]!.target }
    expect(extensionPlacementSchema.parse(placement)).toMatchObject({ height: detail.targets[0]!.height!.default })
    expect(extensionPlacementSchema.safeParse({ ...placement, height: detail.targets[0]!.height!.max + 1 }).success).toBe(false)
    expect(extensionCapabilitiesSchema.parse(await query({ target: 'document.body' })).targets).toEqual([])
    expect(extensionCapabilitiesSchema.parse(await query({ kind: 'runtime' })).targets.map(target => target.target)).toEqual(['commands', 'workbench.panes', 'workbench.interactions'])
    await expect(query({ kind: 'arbitrary' })).rejects.toThrow()
  }
  finally { dispose() }
})

it('prepares platform-independent identities with explicit or default Unicode signatures', async () => {
  const handlers = new Map<string, RuntimeRequestHandler>()
  let author = '山雨海'
  const dispose = registerExtensionAuthoringRpc({ onRequest: (method, handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  } }, async () => { throw new Error('Unexpected inspection') }, () => author)
  try {
    const identity = async (input: unknown) => extensionIdentitySchema.parse(await handlers.get(EXTENSION_IDENTITY_RPC)!(input))
    const first = await identity({ slug: 'music' })
    author = '另一位作者'
    const second = await identity({ slug: 'music', author: 'Équipe 🎨' })
    expect(first).toMatchObject({ author: '山雨海', engines: { lexora: '>=0.9.0 <1.0.0' } })
    expect(first.id).toMatch(/^p[a-f0-9]{32}\.music$/)
    expect(second.id).not.toBe(first.id)
    expect(second.author).toBe('Équipe 🎨')
    expect((await identity({ slug: 'music', author: '' })).author).toBe('')
    await expect(identity({ slug: 'Music!' })).rejects.toThrow()
    await expect(identity({ slug: 'music', author: '名'.repeat(81) })).rejects.toThrow()
  }
  finally { dispose() }
})
