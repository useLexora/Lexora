import type { TSchema } from 'typebox'
import type { ImageGenerationDescription } from './ImageGenerationGateway'
import { Type } from 'typebox'
import { nativeImageSupport } from './imageGenerationSupport'

export function createImageGenerationParameters(description?: ImageGenerationDescription) {
  const operationSupports = description ? [description.generate.map(route => route.support), description.edit.map(route => route.support)].filter(supports => supports.length) : [[nativeImageSupport]]
  const supports = operationSupports.flat()
  const editSupports = description ? description.edit.map(route => route.support) : [nativeImageSupport]
  const properties: Record<string, TSchema> = {
    outputPath: Type.String({
      description: 'Output PNG file path in the current workspace. The extension is optional.',
      maxLength: 4096,
      minLength: 1,
      pattern: '\\S',
    }),
    prompt: Type.String({
      description: 'Describe the desired result. For ordered references, specify the role of each image, changes to make and elements to preserve.',
      maxLength: 32 * 1024,
      minLength: 1,
      pattern: '\\S',
    }),
  }
  if (supports.length) {
    const variants = supports.map((support) => {
      const fields = Object.fromEntries(([['size', 'sizes'], ['quality', 'qualities'], ['background', 'backgrounds']] as const).map(([field, key]) => {
        const values = support[key]
        const schema = Type.Union(values.map(value => Type.Literal(value)))
        return [field, values.includes('auto') ? Type.Optional(schema) : schema]
      }))
      return Type.Object(fields, { additionalProperties: false })
    })
    const unique = [...new Map(variants.map(variant => [JSON.stringify(variant), variant])).values()]
    const output = unique.length === 1 ? unique[0]! : Type.Union(unique)
    const allowsDefaults = operationSupports.every(supports => supports.some(support => support.sizes.includes('auto') && support.qualities.includes('auto') && support.backgrounds.includes('auto')))
    properties.output = allowsDefaults ? Type.Optional(output) : output
  }
  const maxReferences = Math.min(4, Math.max(0, ...editSupports.map(support => support.maxReferenceImages)))
  if (maxReferences > 0) {
    const reference = Type.Union([
      Type.Object({ mode: Type.Literal('latest') }, { additionalProperties: false }),
      Type.Object({
        resourceIds: Type.Array(Type.String({ maxLength: 256, minLength: 1 }), { maxItems: maxReferences, minItems: 1, uniqueItems: true }),
        mode: Type.Literal('resources'),
      }, { additionalProperties: false }),
    ])
    properties.reference = description?.generate.length === 0 ? reference : Type.Optional(reference)
  }
  return Type.Object(properties, { additionalProperties: false })
}

export function describeImageGeneration(description?: ImageGenerationDescription): string {
  const base = 'Generate images through the configured image policy independently of the chat model. Images are saved and shown in the conversation.'
  if (!description)
    return `${base} Backend capabilities have not been declared; accepted adapter parameters do not guarantee backend support for generation, editing or transparency.`
  const routes = (operation: 'generate' | 'edit') => description[operation].length
    ? description[operation].map(route => `${route.title}: ${route.capabilitySource}; sizes=${route.support.sizes.join(',')}; quality=${route.support.qualities.join(',')}; background=${route.support.backgrounds.join(',')}${operation === 'edit' ? `; references<=${Math.min(4, route.support.maxReferenceImages)}` : ''}`).join(' | ')
    : 'unavailable under the current policy'
  return `${base} Current routes in priority order: generate [${routes('generate')}]; edit [${routes('edit')}]. backend_declaration is advertised by the backend; adapter_constraints are accepted transport parameters and actual model capabilities are unverified. Each output variant is a complete parameter combination from one candidate. Select a variant belonging to the requested generate or edit operation; required output may be {} when that operation supports auto defaults; fallback remains limited to the configured policy.`
}
