import type { JsonValue } from '../workbench/workbenchState'
import { z } from 'zod'

export type ExtensionToolParameter = {
  description?: string
} & ({ type: 'string', enum?: string[], minLength?: number, maxLength?: number }
  | { type: 'number', enum?: number[], minimum?: number, maximum?: number }
  | { type: 'boolean' }
  | { type: 'array', items: ExtensionToolParameter, minItems?: number, maxItems: number }
  | { type: 'object', properties: Record<string, ExtensionToolParameter>, required: string[], additionalProperties: false })

const key = z.string().max(80).regex(/^[a-z][a-zA-Z0-9]*$/)
const description = z.string().max(1000).optional()
const primitive = [
  z.object({ type: z.literal('string'), description, enum: z.array(z.string().max(32768)).min(1).max(64).optional(), minLength: z.number().int().min(0).max(32768).optional(), maxLength: z.number().int().min(1).max(32768).optional() }).strict().refine(value => (value.minLength ?? 0) <= (value.maxLength ?? 32768)),
  z.object({ type: z.literal('number'), description, enum: z.array(z.number().finite()).min(1).max(64).optional(), minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict().refine(value => value.minimum === undefined || value.maximum === undefined || value.minimum <= value.maximum),
  z.object({ type: z.literal('boolean'), description }).strict(),
] as const

function objectSchema(child: z.ZodType<ExtensionToolParameter>) {
  return z.object({ type: z.literal('object'), description, properties: z.record(key, child).refine(value => Object.keys(value).length <= 16), required: z.array(key).max(16).default([]), additionalProperties: z.literal(false).default(false) }).strict().refine(value => value.required.every(name => Object.hasOwn(value.properties, name)))
}

function parameterSchema(depth: number): z.ZodType<ExtensionToolParameter> {
  if (!depth)
    return z.union(primitive)
  const child = parameterSchema(depth - 1)
  return z.union([...primitive, objectSchema(child), z.object({ type: z.literal('array'), description, items: child, minItems: z.number().int().min(0).max(256).optional(), maxItems: z.number().int().min(1).max(256).default(128) }).strict().refine(value => (value.minItems ?? 0) <= value.maxItems)])
}

export const extensionToolParametersSchema = objectSchema(parameterSchema(4)).refine((value) => {
  let count = 0
  const visit = (node: ExtensionToolParameter): void => {
    count++
    if (node.type === 'object')
      Object.values(node.properties).forEach(visit)
    if (node.type === 'array')
      visit(node.items)
  }
  visit(value)
  return count <= 128 && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32768
}, 'Tool schema is too large')

const primitiveInput = z.union([z.string().max(32768), z.number().finite(), z.boolean(), z.null()])
function inputSchema(depth: number): z.ZodType<JsonValue> {
  if (!depth)
    return primitiveInput
  const child = inputSchema(depth - 1)
  return z.union([primitiveInput, z.array(child).max(256), z.record(key, child).refine(value => Object.keys(value).length <= 16)])
}
export const extensionToolInputSchema = z.record(key, inputSchema(5)).refine(value => Object.keys(value).length <= 16 && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144)
