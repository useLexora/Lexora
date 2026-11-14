import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { AttachmentService } from './AttachmentService'
import { z } from 'zod'
import { parse } from '../rpc/runtimeRequest'

const idSchema = z.string().trim().min(1).max(256)

export interface RegisterAttachmentRpcOptions {
  rpc: RuntimeRequestRegistrar
  service: Pick<
    AttachmentService,
    'resolvePreview' | 'readPreview'
  >
}

export function registerAttachmentRpc(options: RegisterAttachmentRpcOptions): () => void {
  const disposers = [
    options.rpc.onRequest('attachments.readPreview', (params) => {
      const input = parse(z.object({ attachmentId: idSchema }).strict(), params)
      return options.service.readPreview(input.attachmentId)
    }),
    options.rpc.onRequest('attachments.resolvePreview', (params) => {
      const input = parse(z.object({ attachmentId: idSchema }).strict(), params)
      return options.service.resolvePreview(input.attachmentId)
    }),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
