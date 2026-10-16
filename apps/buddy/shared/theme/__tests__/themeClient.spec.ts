import type { ThemeRequest } from '../themeApi'
import { describe, expect, it } from 'vitest'
import { themeRequestSchema, themeTransportSchema } from '../themeApi'
import { createThemeClient } from '../themeClient'

function client() {
  const sent: ThemeRequest[] = []
  const api = createThemeClient(async (input) => {
    themeTransportSchema.parse(input)
    sent.push(themeRequestSchema.parse(input))
    return { id: 'user.theme.fixture' }
  }, () => ({ dispose() {} }))
  return { api, sent }
}

describe('theme SDK transport', () => {
  it('omits unset fields while preserving zero, null and the caller document', async () => {
    const { api, sent } = client()
    const document = { schemaVersion: 1 as const, materials: [{ anchor: 'workbench.pane' as const, blur: undefined, opacity: 0, image: undefined }], welcome: { image: null, text: undefined } }
    await api.save({ schemaVersion: 1, label: 'Fixture', appearance: 'light', document })
    expect(sent[0]).toMatchObject({ action: 'save', archive: { document: { materials: [{ blur: 0, opacity: 0 }], welcome: { image: null } } } })
    expect(Object.hasOwn(document.materials[0]!, 'blur')).toBe(true)
    expect(document.materials[0]!.blur).toBeUndefined()
  })

  it.each([Number.NaN, 1n, new Date(0), [undefined]])('rejects non-JSON values instead of converting them: %s', async (invalid) => {
    const { api } = client()
    await expect(api.validate({ schemaVersion: 1, invalid })).rejects.toThrow('EXTENSION_THEME_INVALID_REQUEST')
  })

  it('rejects cycles while allowing repeated references to the same plain object', async () => {
    const { api } = client()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(api.validate(cyclic)).rejects.toThrow('EXTENSION_THEME_INVALID_REQUEST')
    const stops = { color: '#207cba', at: 0 }
    await api.resolve('light', { schemaVersion: 1, materials: [{ anchor: 'workbench.pane', gradient: { angle: 0, stops: [stops, stops] } }] })
  })
})
