import { z } from 'zod'

export const CLIPBOARD_IMAGE_MAX_BYTES = 32 * 1024 * 1024
export const CLIPBOARD_IMAGE_MAX_PIXELS = 64 * 1024 * 1024

export const clipboardWriteImageInputSchema = z.object({
  png: z.instanceof(Uint8Array).refine((bytes) => {
    if (bytes.length < 33 || bytes.length > CLIPBOARD_IMAGE_MAX_BYTES)
      return false
    const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]
    if (!signature.every((value, index) => bytes[index] === value))
      return false
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = header.getUint32(16)
    const height = header.getUint32(20)
    return width > 0 && height > 0 && width * height <= CLIPBOARD_IMAGE_MAX_PIXELS
  }, 'Invalid or oversized clipboard PNG'),
}).strict()
