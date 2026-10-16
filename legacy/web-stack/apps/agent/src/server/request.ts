export function resolveHeaderRequestId(header: string | string[] | undefined): string | null {
  const requestId = Array.isArray(header) ? header[0] : header

  return requestId?.trim() || null
}
