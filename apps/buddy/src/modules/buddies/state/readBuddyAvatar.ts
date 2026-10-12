export async function readBuddyAvatar(source: Blob | string): Promise<string> {
  const blob = typeof source === 'string' ? await readPreset(source) : source
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context)
      throw new Error('IMAGE_UNAVAILABLE')
    const side = Math.min(bitmap.width, bitmap.height)
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
    return canvas.toDataURL('image/png')
  }
  finally { bitmap.close() }
}

async function readPreset(source: string) {
  const response = await fetch(source)
  if (!response.ok)
    throw new Error('IMAGE_UNAVAILABLE')
  return response.blob()
}
