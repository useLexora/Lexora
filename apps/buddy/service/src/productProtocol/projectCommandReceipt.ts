import type { CommandReceiptSnapshot } from '../storage/CommandCommitter'
import { productCommandReceiptSchema, productReceiptResultSchema, productReceiptTargetSchema } from '../../../shared/productProtocol/receipts'
import { encodeProductRevision } from '../../../shared/productProtocol/scalars'

export function projectCommandReceipt(receipt: CommandReceiptSnapshot) {
  const target = Object.fromEntries(Object.keys(productReceiptTargetSchema.shape).filter(key => receipt.target[key] !== undefined).map(key => [key, receipt.target[key]]))
  const result: Record<string, unknown> = {}
  for (const [key, valueSchema] of Object.entries(productReceiptResultSchema.shape)) {
    let value: unknown = receipt.result[key]
    if (value === undefined || (key === 'draftReceipt' && value === null))
      continue
    if (['revision', 'slotRevision', 'sourceRevision', 'titleRevision', 'assignmentRevision', 'readRevision'].includes(key))
      value = encodeProductRevision(value as number)
    if (key === 'draftReceipt' && value && typeof value === 'object') {
      const draft = value as { draftId: string, committedRevision: number }
      value = { draftId: draft.draftId, committedRevision: encodeProductRevision(draft.committedRevision) }
    }
    if (key === 'reason' && !valueSchema.safeParse(value).success)
      continue
    result[key] = value
  }
  return productCommandReceiptSchema.parse({
    dataGeneration: receipt.dataGeneration,
    commandId: receipt.commandId,
    method: receipt.method,
    decision: receipt.decision,
    decidedAt: receipt.decidedAt,
    target,
    result,
    ...(receipt.decision === 'rejected' ? { errorCode: receipt.errorCode } : {}),
  })
}
