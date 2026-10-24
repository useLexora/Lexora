import type { TSchema } from 'typebox'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { ExtensionToolParameter } from '../../../shared/extensions/extensionToolParameters'
import { Type } from 'typebox'

export function extensionToolSchema(parameter: EventSnapshot<ExtensionToolParameter>): TSchema {
  const options = parameter.description ? { description: parameter.description } : {}
  switch (parameter.type) {
    case 'string': return Type.String({ ...options, minLength: parameter.minLength, maxLength: parameter.maxLength ?? 32768, ...parameter.enum ? { enum: [...parameter.enum] } : {} })
    case 'number': return Type.Number({ ...options, minimum: parameter.minimum, maximum: parameter.maximum, ...parameter.enum ? { enum: [...parameter.enum] } : {} })
    case 'boolean': return Type.Boolean(options)
    case 'array': return Type.Array(extensionToolSchema(parameter.items), { ...options, minItems: parameter.minItems, maxItems: parameter.maxItems })
    case 'object': return Type.Object(Object.fromEntries(Object.entries(parameter.properties).map(([name, value]) => {
      const child = extensionToolSchema(value)
      return [name, parameter.required.includes(name) ? child : Type.Optional(child)]
    })), { ...options, additionalProperties: false })
  }
}
