import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { lexoraConfigPatchSchema } from '../desktopApiSchemas'
import { welcomeCompanionImageSchema } from '../welcomeCompanionImage'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aU1cAAAAASUVORK5CYII='
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

describe('welcome companion image contract', () => {
  it('accepts presets and original raster data URLs at the desktop bridge', () => {
    for (const welcomeCompanionImage of ['lexora', 'whale', png, gif]) {
      const patch = { desktop: { chat: { welcomeCompanionImage } } }
      expect(lexoraConfigPatchSchema.parse(patch)).toEqual(patch)
    }
  })

  it('accepts gallery-only patches without adding a selection and rejects builtins or non-array galleries', () => {
    for (const welcomeCompanionImages of [[], [png, gif, png]]) {
      const patch = { desktop: { chat: { welcomeCompanionImages } } }
      expect(lexoraConfigPatchSchema.parse(patch)).toEqual(patch)
    }
    for (const welcomeCompanionImages of [['lexora'], ['whale'], [png, 42], null, png]) {
      expect(lexoraConfigPatchSchema.safeParse({ desktop: { chat: { welcomeCompanionImages } } }).success).toBe(false)
    }
  })

  it('rejects external, executable, malformed and MIME-spoofed values', () => {
    for (const value of [
      '',
      'unknown',
      'https://example.com/image.png',
      'file:///image.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:text/html;base64,PHN2Zy8+',
      'data:image/png;base64,PHN2Zy8+',
      'data:image/gif;base64,AAAA',
      png.replace('image/png', 'image/jpeg'),
      gif.replace('image/gif', 'image/webp'),
      png.replace('base64,', 'base64,\n'),
      png.slice(0, -1),
      `${gif}=`,
      'data:image/png;base64,!!!!',
    ]) {
      expect(lexoraConfigPatchSchema.safeParse({ desktop: { chat: { welcomeCompanionImage: value } } }).success).toBe(false)
      expect(lexoraConfigPatchSchema.safeParse({ desktop: { chat: { welcomeCompanionImages: [png, value] } } }).success).toBe(false)
    }
  })

  it('accepts files through 5 MiB and rejects larger files, including the base64 padding boundary', () => {
    const bytes = Buffer.from(gif.split(',')[1]!, 'base64')
    const padded = (size: number) => {
      const value = Buffer.alloc(size)
      bytes.copy(value)
      value[value.length - 1] = 0x3B
      return `data:image/gif;base64,${value.toString('base64')}`
    }
    const limit = 5 * 1024 * 1024
    expect(welcomeCompanionImageSchema.safeParse(padded(limit)).success).toBe(true)
    expect(welcomeCompanionImageSchema.safeParse(padded(limit + 1)).success).toBe(false)
    expect(welcomeCompanionImageSchema.safeParse(padded(limit + 3)).success).toBe(false)
  })
})
