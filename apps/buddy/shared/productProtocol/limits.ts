export const PRODUCT_LIMITS = Object.freeze({
  snapshotLifetimeMs: 30_000,
  dynamicTopics: 128,
  subscriptionsPerConnection: 64,
  inFlightRequests: 64,
  frameBytes: 1_048_576,
  pageItems: 100,
  pageBytes: 524_288,
  topicItems: 1024,
  topicBytes: 2_097_152,
  subscriptionItems: 256,
  subscriptionBytes: 1_048_576,
  connectionBytes: 4_194_304,
})
const encoder = new TextEncoder()
export function productByteLength(text: string): number {
  return encoder.encode(text).byteLength
}
export function encodeProductFrame(value: unknown, limit: number = PRODUCT_LIMITS.frameBytes): string {
  const text = JSON.stringify(value)
  if (typeof text !== 'string' || productByteLength(text) > limit)
    throw new RangeError('FRAME_TOO_LARGE')
  return text
}
