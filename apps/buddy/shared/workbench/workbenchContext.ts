import { z } from 'zod'

const contextValueSchema = z.union([z.string().max(256), z.boolean(), z.number().finite()])
const contextKeySchema = z.string().max(100).regex(/^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/)
export const workbenchConditionSchema = z.record(contextKeySchema, z.union([contextValueSchema, z.array(contextValueSchema).min(1).max(32)])).refine(value => Object.keys(value).length <= 32, 'Too many context conditions')
export type WorkbenchCondition = z.infer<typeof workbenchConditionSchema>
export type WorkbenchContextValues = Readonly<Record<string, string | boolean | number>>
export interface WorkbenchContextSnapshot {
  readonly values: WorkbenchContextValues
  readonly pages: readonly { readonly id: string, readonly title: string }[]
}

export function matchesWorkbenchContext(condition: WorkbenchCondition | undefined, values: WorkbenchContextValues): boolean {
  return !condition || Object.entries(condition).every(([key, expected]) => Object.hasOwn(values, key) && (Array.isArray(expected) ? expected.includes(values[key]!) : values[key] === expected))
}
