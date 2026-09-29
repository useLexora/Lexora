import type { Api, Model } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import type { SessionToolChange } from '../SessionToolCapabilities'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'
import { SessionToolCapabilities } from '../SessionToolCapabilities'

const tools: ToolInfo[] = ['read', 'create_image'].map(name => ({ name, description: name, parameters: Type.Object({}), sourceInfo: { source: 'extension', path: '', origin: 'top-level', scope: 'temporary' } }))
const model = { provider: 'fixture', id: 'images' } as Model<Api>
function setup() {
  const state = new SessionToolCapabilities([{ source: 'connector', id: 'fixture', revision: 'catalog-1' }])
  const events: SessionToolChange[] = []
  state.onDidChange(event => events.push(event))
  state.initialize(tools, ['read'], [{ source: { kind: 'builtin', id: 'images', title: 'Images' }, exposure: 'on_demand', tools: [{ name: 'create_image' }], keywords: '', available: ({ model }) => model?.id === 'images' }])
  let active = ['read']
  const adapter = { getActiveTools: () => [...active], setActiveTools: (value: string[]) => {
    active = [...value]
  } }
  state.apply(state.resolve({ model }), 'initial', adapter)
  return { state, events, adapter }
}

describe('session capability facts', () => {
  it('keeps disclosure committed when Pi application fails and only reports confirmed active tools', () => {
    const { state, events, adapter } = setup()
    state.search({ toolNames: ['create_image'] }, { model })
    expect(state.snapshot.discovered).toEqual(['create_image'])
    expect(state.snapshot.active).toEqual(['read'])
    expect(() => state.apply(state.resolve({ model }), 'discovery', { ...adapter, setActiveTools: () => {
      throw new Error('Pi rejected application')
    } })).toThrow('Pi rejected')
    expect(state.snapshot).toMatchObject({ status: 'degraded', active: ['read'], disclosureRevision: 1 })
    expect(events.at(-1)?.kind).toBe('application-failed')
    state.apply(state.resolve({ model }), 'context', adapter)
    expect(state.snapshot).toMatchObject({ status: 'ready', active: ['create_image', 'read'] })
    const revision = state.snapshot.revision
    state.search({ toolNames: ['create_image'] }, { model })
    state.apply(state.resolve({ model }), 'context', adapter)
    expect(state.snapshot.revision).toBe(revision)
    expect(Object.isFrozen(events.at(-1)?.snapshot.active)).toBe(true)
  })

  it('separates model filtering from restored disclosure and rejects writes after disposal', () => {
    const { state, events, adapter } = setup()
    state.search({ toolNames: ['create_image'] }, { model })
    state.apply(state.resolve({ model }), 'discovery', adapter)
    state.apply(state.resolve({ model: { ...model, id: 'text' } }), 'model', adapter)
    expect(state.snapshot).toMatchObject({ discovered: ['create_image'], active: ['read'] })
    state.restore([])
    expect(events.at(-1)).toMatchObject({ kind: 'disclosure-changed', reason: 'restore' })
    state.apply(state.resolve({ model }), 'tree', adapter)
    expect(state.snapshot).toMatchObject({ discovered: [], active: ['read'] })
    state.dispose()
    expect(events.at(-1)?.kind).toBe('disposed')
    expect(() => state.search({ toolNames: ['create_image'] }, { model })).toThrow('SESSION_TOOLS_DISPOSED')
  })
})
