import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { ProductProtocolError } from '../../../shared/productProtocol/errors'
import { hasDocumentSignature } from '../attachments/validateDocumentBytes'

export async function validateDocumentBytes(path: string, mimeType: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(1024)
    const { bytesRead } = await file.read(bytes)
    if (!hasDocumentSignature(mimeType, bytes.subarray(0, bytesRead)))
      throw new ProductProtocolError('RESOURCE_UNAVAILABLE')
  }
  finally { await file.close() }
}
