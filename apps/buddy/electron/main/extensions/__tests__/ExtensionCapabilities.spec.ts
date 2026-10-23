import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { expect, it, vi } from 'vitest'
import { EXTENSION_CAPABILITIES_RPC, extensionCapabilitiesSchema } from '../../../../shared/extensions/extensionAuthoring'
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
    expect(detail.targets).toEqual([expect.objectContaining({ kind: 'slot', target: 'composer.accessory', selection: 'multiple' })])
    const placement = { id: 'tests.content.slot', view: 'tests.content.view', kind: 'slot', target: detail.targets[0]!.target }
    expect(extensionPlacementSchema.parse({ ...placement, enabled: false })).toMatchObject({ height: detail.targets[0]!.height!.default, enabled: false })
    expect(extensionPlacementSchema.safeParse({ ...placement, height: detail.targets[0]!.height!.max + 1 }).success).toBe(false)
    expect(extensionCapabilitiesSchema.parse(await query({ target: 'document.body' })).targets).toEqual([])
    const runtime = extensionCapabilitiesSchema.parse(await query({ kind: 'runtime' }))
    expect(runtime.targets.map(target => target.target)).toContain('themes')
    expect(runtime.targets.every(target => target.kind === 'runtime')).toBe(true)
    await expect(query({ kind: 'arbitrary' })).rejects.toThrow()
  }
  finally { await dispose() }
})
