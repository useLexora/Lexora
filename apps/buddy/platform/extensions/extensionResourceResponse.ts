export function extensionResourceRange(size: number, raw: string | null): { start: number, end: number, status: number, headers: Record<string, string> } {
  const headers: Record<string, string> = { 'accept-ranges': 'bytes', 'content-length': String(size) }
  if (!raw)
    return { start: 0, end: size - 1, status: 200, headers }
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw)
  let start = Number.NaN
  let end = size - 1
  if (match && (match[1] || match[2])) {
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size)
    return { start: 0, end: -1, status: 416, headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}`, 'content-length': '0' } }
  return { start, end, status: 206, headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` } }
}
