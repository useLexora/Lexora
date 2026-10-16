import { z } from 'zod'
import { ApiErrorCodeSchema } from './status-code'

export const CountSchema = z.number().int().nonnegative()

export const RequestPageParamsSchema = z.object({
  pageNo: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
}).strict()

export const RequestResponseSchema = z.object({
  code: z.number().int(),
  errorCode: ApiErrorCodeSchema.nullable().optional(),
  message: z.string(),
  data: z.unknown().nullable(),
}).strict()

export function createPageDataSchema<ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) {
  return z.object({
    total: CountSchema,
    items: z.array(itemSchema),
  }).strict()
}

export type IsoDateTimeString = string

export interface RequestPageParams {
  pageNo: number
  pageSize: number
}

export interface PageData<T> {
  total: number
  items: T[]
}

type RequestResponseEnvelope = z.infer<typeof RequestResponseSchema>

export type RequestResponse<T = unknown> = Omit<RequestResponseEnvelope, 'data'> & {
  data: T | null
}
