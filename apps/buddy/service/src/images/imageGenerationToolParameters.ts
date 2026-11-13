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
      description: 'Output PNG path, relative to the current workspace, for example output/edited.png. A leading / means the filesystem root, not the workspace. Use an absolute path only when it is the actual intended, writable destination. The extension is optional.',
      maxLength: 4096,
      minLength: 1,
      pattern: '\\S',
    }),
    prompt: Type.String({
      description: 'For reference-based edits, write a short edit instruction using numbered image roles, for example: keep image 1 unchanged except apply the pose from image 2. Let the actual images supply unchanged appearance and rendering style; do not rewrite an appearance inventory or guess anatomy, colors, logos or lettering. For generation without references, describe the desired result.',
      maxLength: 32 * 1024,
      minLength: 1,
      pattern: '\\S',
    }),
  }
  if (supports.length) {
    const variants = supports.flatMap((support) => {
      const fields = Object.fromEntries(([['size', 'sizes'], ['quality', 'qualities'], ['background', 'backgrounds']] as const).map(([field, key]) => {
        const values = support[key]
        const schema = Type.Union(values.map(value => Type.Literal(value)))
        return [field, values.includes('auto') ? Type.Optional(schema) : schema]
      }))
      const variants: TSchema[] = [Type.Object(fields, { additionalProperties: false })]
      if (support.sizes.includes('auto') && (support.resolutions || support.aspectRatios)) {
        variants.push(Type.Object({
          ...fields,
          size: Type.Optional(Type.Literal('auto')),
          ...(support.resolutions ? { resolution: Type.Optional(Type.Union(support.resolutions.map(value => Type.Literal(value)))) } : {}),
          ...(support.aspectRatios ? { aspectRatio: Type.Optional(Type.Union(support.aspectRatios.map(value => Type.Literal(value)))) } : {}),
        }, { additionalProperties: false }))
      }
      return variants
    })
    const unique = [...new Map(variants.map(variant => [JSON.stringify(variant), variant])).values()]
    const output = unique.length === 1 ? unique[0]! : Type.Union(unique)
    const allowsDefaults = operationSupports.every(supports => supports.some(support => support.sizes.includes('auto') && support.qualities.includes('auto') && support.backgrounds.includes('auto')))
    properties.output = allowsDefaults ? Type.Optional(output) : output
  }
  const maxReferences = Math.min(4, Math.max(0, ...editSupports.map(support => support.maxReferenceImages)))
  if (maxReferences > 0) {
    const referenceIds = Type.Array(Type.String({ maxLength: 256, minLength: 1, pattern: '\\S' }), {
      description: 'Required when the task uses reference images or edits an existing image, including references from earlier turns. List ALL intended images in order: a character image plus a pose image requires BOTH IDs. Copy attachmentId or artifactId from attachments, outputs or lexora_image_list; not composer resourceIds, paths or image: hashes. Omit only for a new image that uses no references.',
      maxItems: maxReferences,
      minItems: 1,
      uniqueItems: true,
    })
    properties.referenceIds = description?.generate.length === 0 ? referenceIds : Type.Optional(referenceIds)
  }
  return Type.Object(properties, { additionalProperties: false })
}

export function describeImageGeneration(description?: ImageGenerationDescription): string {
  const base = 'Generate or edit images. The image backend receives only this prompt and the images explicitly listed in referenceIds: it cannot see chat attachments, conversation history or lexora_image_read results. For reference-based tasks, pass every intended reference image, not a text description in its place. Without referenceIds this is text-to-image generation, not an edit of the user\'s images. Size, background and quality are requests, not guarantees; inspect actual outputs before claiming those properties. A local publication failure may return retainedOutputs: copy and present those saved files without another generation request.'
  if (!description)
    return `${base} Backend capabilities have not been declared; accepted adapter parameters do not guarantee backend support for generation, editing or transparency.`
  const routes = (operation: 'generate' | 'edit') => description[operation].length
    ? description[operation].map(route => `${route.title}: ${route.capabilitySource}; sizes=${route.support.sizes.join(',')}; quality=${route.support.qualities.join(',')}; background=${route.support.backgrounds.join(',')}${route.support.resolutions ? `; resolution=${route.support.resolutions.join(',')}` : ''}${route.support.aspectRatios ? `; aspectRatio=${route.support.aspectRatios.join(',')}` : ''}${operation === 'edit' ? `; references<=${Math.min(4, route.support.maxReferenceImages)}` : ''}`).join(' | ')
    : 'unavailable under the current policy'
  return `${base} Current routes in priority order: generate [${routes('generate')}]; edit [${routes('edit')}]. backend_declaration is advertised by the backend; adapter_constraints are accepted transport parameters and actual model capabilities are unverified. Each output variant is a complete parameter combination from one candidate. Pixel size cannot be combined with resolution or aspectRatio. Select a variant belonging to the requested generate or edit operation; required output may be {} when that operation supports auto defaults; fallback remains limited to the configured policy.`
}
