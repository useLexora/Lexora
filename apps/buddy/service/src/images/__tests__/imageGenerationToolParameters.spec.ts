import type { ImageSupport } from '../../../../shared/images/imagePreferences'
import type { ImageGenerationRoute } from '../ImageGenerationGateway'
import { Check } from 'typebox/value'
import { describe, expect, it } from 'vitest'
import { createImageGenerationParameters } from '../imageGenerationToolParameters'

const input = { prompt: 'fixture', outputPath: 'fixture.png' }
const generator = route({ operations: ['generate'], maxReferenceImages: 0, sizes: ['1024x1024'], qualities: ['high'], backgrounds: ['opaque'] })
const fallback = route({ operations: ['generate'], maxReferenceImages: 0, sizes: ['1536x1024'], qualities: ['low'], backgrounds: ['transparent'] })
const editor = route({ operations: ['edit'], maxReferenceImages: 2, sizes: ['auto'], qualities: ['auto'], backgrounds: ['auto'] })

describe('image generation parameter contracts', () => {
  it('accepts complete candidate combinations and rejects impossible mixtures across fallback routes', () => {
    const schema = createImageGenerationParameters({ generate: [generator, fallback], edit: [] })
    expect(Check(schema, { ...input, output: { size: '1024x1024', quality: 'high', background: 'opaque' } })).toBe(true)
    expect(Check(schema, { ...input, output: { size: '1536x1024', quality: 'low', background: 'transparent' } })).toBe(true)
    expect(Check(schema, { ...input, output: { size: '1024x1024', quality: 'high', background: 'transparent' } })).toBe(false)
    expect(schema.type).toBe('object')
  })

  it('does not advertise omittable output when generation has no default candidate but editing does', () => {
    const schema = createImageGenerationParameters({ generate: [generator], edit: [editor] })
    expect(Check(schema, input)).toBe(false)
    expect(Check(schema, { ...input, output: {}, reference: { mode: 'latest' } })).toBe(true)
    expect(Check(schema, { ...input, output: { size: '1024x1024', quality: 'high', background: 'opaque' } })).toBe(true)
  })

  it('requires references for edit-only routes and excludes them for generation-only routes', () => {
    const editOnly = createImageGenerationParameters({ generate: [], edit: [editor] })
    expect(Check(editOnly, input)).toBe(false)
    expect(Check(editOnly, { ...input, reference: { mode: 'latest' } })).toBe(true)
    const generateOnly = createImageGenerationParameters({ generate: [generator], edit: [] })
    expect(generateOnly.properties).not.toHaveProperty('reference')
    expect(Check(generateOnly, { ...input, output: { size: '1024x1024', quality: 'high', background: 'opaque' }, reference: { mode: 'latest' } })).toBe(false)
  })
})

function route(support: ImageSupport): ImageGenerationRoute {
  return { target: { kind: 'plugin', extensionId: 'fixture', modelId: 'fixture' }, title: 'Fixture', capabilitySource: 'backend_declaration', support }
}
