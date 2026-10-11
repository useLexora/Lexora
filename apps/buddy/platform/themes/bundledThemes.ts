import type { ExtensionPackageStore } from '../extensions/ExtensionPackageStore'
import { join } from 'node:path'
import manifest from '../../extensions/bundled/lexora.themes/extension.json'
import icon from '../../extensions/bundled/lexora.themes/icon.svg?raw'
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
    ['icon.svg', encoder.encode(icon)],
    ...Object.entries(themes).map(([name, document]) => [`themes/${name}.json`, encoder.encode(JSON.stringify(document))] as const),
  ])
}

export async function seedBundledThemes(store: ExtensionPackageStore): Promise<void> {
  const marker = join(store.root, 'bundled-themes.json')
  let seeded = false
  try {
    await readExtensionJson(marker)
    seeded = true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
  const installed = store.installed[manifest.id]
  const upgrade = installed && !installed.development && !installed.pending && installed.current.manifest.version === '1.0.0' && installed.current.manifest.name === 'Lexora 官方主题'
  if ((!seeded && !installed) || upgrade) {
    const review = await store.reviewFiles(bundledThemeFiles())
    await store.install(review.token)
    if (upgrade)
      await store.promote(manifest.id)
  }
  if (!seeded)
    await writeExtensionJson(marker, { version: 1 })
}
