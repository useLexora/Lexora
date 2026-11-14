import { z } from 'zod'
import { buddyUserContentV1Schema } from '../conversation/buddyUserContent'
import { productEditableContentSchema } from './content'
import { PRODUCT_LIMITS } from './limits'

export const productExchangeSchema = z.object({ frame: z.string().max(PRODUCT_LIMITS.frameBytes) }).strict()
export const productExchangeResultSchema = z.object({ received: z.literal(true) }).strict()
export const productFrameNotification = { method: 'product.frame', params: productExchangeSchema } as const
export const productExchange = { method: 'product.exchange', input: productExchangeSchema, response: productExchangeResultSchema } as const

export const desktopProductContentProject = { method: 'product.content.project', input: z.object({ content: buddyUserContentV1Schema }).strict(), response: z.object({ content: productEditableContentSchema }).strict() } as const
