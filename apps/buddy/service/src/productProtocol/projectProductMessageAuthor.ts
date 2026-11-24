import { productMessageSchema } from '../../../shared/productProtocol/views'

const authorIdentity = productMessageSchema.shape.author.unwrap().pick({ id: true, name: true }).strip()

export function projectProductMessageAuthor(snapshotJson: unknown) {
  if (typeof snapshotJson !== 'string')
    return undefined
  let snapshot: unknown
  try {
    snapshot = JSON.parse(snapshotJson)
  }
  catch {
    return undefined
  }
  const author = authorIdentity.safeParse(snapshot)
  return author.success ? author.data : undefined
}
