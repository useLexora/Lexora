import type { ZodType } from 'zod'
import type { LocalConversation } from '../../../shared/conversation/conversationApi'
import type { ProductMethod } from '../../../shared/productProtocol/methods'
import type { ProviderService } from '../providers/ProviderService'
import type { ProductRequestHandler } from './ProductConnection'
import { createHash } from 'node:crypto'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { PRODUCT_LIMITS, productByteLength } from '../../../shared/productProtocol/limits'
import { decodeProductCursor, encodeProductCursor, encodeProductRevision } from '../../../shared/productProtocol/scalars'
import { productModelSchema, productProviderSchema } from '../../../shared/productProtocol/views'

export function createProductModelQueries(providers: ProviderService, inputSelection: (conversationId?: string) => LocalConversation['modelSelection']): Partial<Record<ProductMethod, ProductRequestHandler>> {
  const paginate = (scope: string, input: unknown, items: unknown[], schema: ZodType) => {
    const request = input as { cursor: string | null, limit: number }
    const publicItems = items.map(item => schema.parse(item))
    const hash = createHash('sha256').update(JSON.stringify(publicItems)).digest('hex')
    const cursorScope = createHash('sha256').update(JSON.stringify([scope, hash])).digest('hex')
    let position = 0
    if (request.cursor) {
      try {
        position = Number(decodeProductCursor(request.cursor, { scope: cursorScope, branchId: null, revision: '0' }).position)
      }
      catch { throw new ProductProtocolError('CURSOR_EXPIRED') }
    }
    const page: unknown[] = []
    for (const item of publicItems.slice(position, position + request.limit)) {
      if (productByteLength(JSON.stringify([...page, item])) > PRODUCT_LIMITS.pageBytes - 4096)
        break
      page.push(item)
    }
    if (position < publicItems.length && !page.length)
      throw new ProductProtocolError('PAGE_TOO_LARGE')
    position += page.length
    return { items: page, nextCursor: position < publicItems.length ? encodeProductCursor({ version: 1, scope: cursorScope, branchId: null, revision: '0', upperBound: encodeProductRevision(publicItems.length), position: encodeProductRevision(position) }) : null }
  }
  return {
    'providers.getInputSelection': { handle: async (input) => {
      const selection = inputSelection((input as { conversationId?: string }).conversationId) ?? await providers.getDefaultModel()
      return { modelSelection: selection ? { ...selection, serviceTier: 'serviceTier' in selection ? selection.serviceTier : null } : null }
    } },
    'providers.list': { handle: async input => paginate('providers', input, (await providers.listProviders()).map(provider => Object.fromEntries(Object.keys(productProviderSchema.shape).map(key => [key, provider[key as keyof typeof provider]]))), productProviderSchema) },
    'providers.listModels': { handle: async (input) => {
      const providerId = (input as { providerId?: string }).providerId
      const models = await providers.listModels(providerId)
      return paginate(`models:${providerId ?? ''}`, input, models.map(model => Object.fromEntries(Object.keys(productModelSchema.shape).map((key) => {
        if (key === 'modelId')
          return [key, model.id]
        if (key === 'serviceTiers')
          return [key, model.type === 'chat' ? providers.executionModels.getServiceTiers({ api: model.api, modelId: model.id, providerId: model.providerId }) : []]
        return [key, model[key as keyof typeof model]]
      }))), productModelSchema)
    } },
    'providers.getModelSnapshot': { handle: () => providers.getModelSnapshot() },
  }
}
