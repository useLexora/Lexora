import type { ExtensionManifest } from '../../shared/extensions/extensionManifest'
import { createGenerator } from '@unocss/core'
import presetWind3 from 'unocss/preset-wind3'
import { EXTENSION_UNO_STYLESHEET } from '../../shared/extensions/extensionStyles.ts'
import { createUnoTheme } from '../../shared/theme/themeTokens.ts'

export async function compileExtensionStyles(files: ReadonlyMap<string, Uint8Array>, manifest: ExtensionManifest): Promise<Uint8Array | null> {
  if (!manifest.styles?.uno)
    return null
  if ([...files.keys()].some(name => name.toLowerCase() === EXTENSION_UNO_STYLESHEET))
    throw new Error('EXTENSION_SOURCE_OUTPUT_COLLISION')
  const uno = await createGenerator({
    presets: [presetWind3()],
    theme: createUnoTheme('lexora'),
    safelist: manifest.styles.safelist,
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const tokens = new Set<string>()
  for (const [name, bytes] of files) {
    if (/\.(?:[cm]?[jt]s|html)$/.test(name) && !/\.d\.[cm]?ts$/.test(name))
      await uno.applyExtractors(decoder.decode(bytes), name, tokens)
  }
  const { css } = await uno.generate(tokens)
  return new TextEncoder().encode(css)
}
