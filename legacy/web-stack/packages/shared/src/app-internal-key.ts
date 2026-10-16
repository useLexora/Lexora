import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

export function readAppInternalKeyHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  const normalized = value?.trim()

  return normalized || null
}

export function isMatchingAppInternalKey(expected: string, received: string | null | undefined): boolean {
  const expectedKey = expected.trim()
  const receivedKey = received?.trim() ?? ''

  if (!expectedKey || !receivedKey) {
    return false
  }

  const expectedBuffer = Buffer.from(expectedKey)
  const receivedBuffer = Buffer.from(receivedKey)

  return expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer)
}
