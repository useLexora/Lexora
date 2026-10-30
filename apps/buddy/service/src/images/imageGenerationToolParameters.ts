import { Type } from 'typebox'

export const imageGenerationParameters = Type.Object({
  output: Type.Optional(Type.Object({
    size: Type.String({ pattern: '^(auto|[1-9]\\d{1,3}x[1-9]\\d{1,3})$' }),
    quality: Type.Union([Type.Literal('auto'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    background: Type.Union([Type.Literal('auto'), Type.Literal('opaque'), Type.Literal('transparent')]),
  }, { additionalProperties: false })),
  outputPath: Type.String({
    description: 'Output file path in the current workspace. The image extension is optional.',
    maxLength: 4096,
    minLength: 1,
    pattern: '\\S',
  }),
  prompt: Type.String({ maxLength: 32 * 1024, minLength: 1, pattern: '\\S' }),
  reference: Type.Optional(Type.Union([
    Type.Object({
      mode: Type.Literal('latest'),
    }, { additionalProperties: false }),
    Type.Object({
      resourceIds: Type.Array(Type.String({ maxLength: 256, minLength: 1 }), {
        maxItems: 4,
        minItems: 1,
        uniqueItems: true,
      }),
      mode: Type.Literal('resources'),
    }, { additionalProperties: false }),
  ])),
}, { additionalProperties: false })
