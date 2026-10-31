export function detectReadingImageMime(bytes: Uint8Array): string | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
    return 'image/png'
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF && bytes[3] !== 0xF7)
    return 'image/jpeg'
  const header = String.fromCharCode(...bytes.subarray(0, 12))
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a'))
    return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP')
    return 'image/webp'
  if (header.startsWith('BM') && bytes.length >= 26)
    return 'image/bmp'
  return null
}
