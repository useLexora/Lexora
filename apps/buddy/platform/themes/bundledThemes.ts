import type { ExtensionPackageStore } from '../extensions/ExtensionPackageStore'
import { join } from 'node:path'
import manifest from '../../extensions/bundled/lexora.themes/extension.json'
import license from '../../extensions/bundled/lexora.themes/LICENSE?raw'
import amberDark from '../../extensions/bundled/lexora.themes/themes/amber-dark.json'
import amberLight from '../../extensions/bundled/lexora.themes/themes/amber-light.json'
import classicDark from '../../extensions/bundled/lexora.themes/themes/classic-dark.json'
import classicLight from '../../extensions/bundled/lexora.themes/themes/classic-light.json'
import greenDark from '../../extensions/bundled/lexora.themes/themes/green-dark.json'
import greenLight from '../../extensions/bundled/lexora.themes/themes/green-light.json'
import roseDark from '../../extensions/bundled/lexora.themes/themes/rose-dark.json'
import roseLight from '../../extensions/bundled/lexora.themes/themes/rose-light.json'
import violetDark from '../../extensions/bundled/lexora.themes/themes/violet-dark.json'
import violetLight from '../../extensions/bundled/lexora.themes/themes/violet-light.json'
import { readExtensionJson, writeExtensionJson } from '../extensions/extensionFiles'

export function bundledThemeFiles(): Map<string, Uint8Array> {
  const encoder = new TextEncoder()
  const themes = { 'classic-light': classicLight, 'classic-dark': classicDark, 'green-light': greenLight, 'green-dark': greenDark, 'violet-light': violetLight, 'violet-dark': violetDark, 'rose-light': roseLight, 'rose-dark': roseDark, 'amber-light': amberLight, 'amber-dark': amberDark }
  return new Map([
    ['extension.json', encoder.encode(JSON.stringify(manifest))],
    ['LICENSE', encoder.encode(license)],
    ...Object.entries(themes).map(([name, document]) => [`themes/${name}.json`, encoder.encode(JSON.stringify(document))] as const),
  ])
}

export async function seedBundledThemes(store: ExtensionPackageStore): Promise<void> {
  const marker = join(store.root, 'bundled-themes.json')
  try {
    await readExtensionJson(marker)
    return
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
  if (!store.installed[manifest.id]) {
    const review = await store.reviewFiles(bundledThemeFiles())
    await store.install(review.token)
  }
  await writeExtensionJson(marker, { version: 1 })
}
