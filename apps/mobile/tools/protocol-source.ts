import { taskMarkInputSchema } from '../../buddy/shared/conversation/taskMarkApi'

export * as pairing from '../../buddy/shared/privateNetwork/pairing'
export { REMOTE_UPLOAD_POLICY } from '../../buddy/shared/privateNetwork/uploads'
export { productContentSchema } from '../../buddy/shared/productProtocol/content'
export { productInitializeResultSchema, productInitializeSchema } from '../../buddy/shared/productProtocol/identity'
export { PRODUCT_METHODS } from '../../buddy/shared/productProtocol/methods'
export * as sync from '../../buddy/shared/productProtocol/sync'
export { PRODUCT_TOPIC_SCHEMAS } from '../../buddy/shared/productProtocol/topics'

export const MOBILE_SCHEMA_OVERRIDES = new Map([
  [taskMarkInputSchema.shape.color.out, { type: 'string', pattern: '^#[\\da-f]{6}$' }],
])

export { READER_SCHEMAS } from '../../buddy/src/mobile-reader/readerProtocol'
