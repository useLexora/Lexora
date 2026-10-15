import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import associations from '../materialFolderAssociations.json'
import { resolveFolderIcon } from '../resolveFolderIcon'

describe('folder icon associations', () => {
  it('ships every icon referenced by folder names in both appearances', async () => {
    const assets = new Set<string>()
    for (const name of Object.keys(associations.names)) {
      for (const appearance of ['light', 'dark'] as const) {
        assets.add(resolveFolderIcon(name, false, appearance))
        assets.add(resolveFolderIcon(name, true, appearance))
      }
    }
    assets.add(resolveFolderIcon())
    assets.add(resolveFolderIcon('', true))
    await Promise.all([...assets].map(async (icon) => {
      const svg = await readFile(new URL(`../assets/material-folders/${icon}.svg`, import.meta.url), 'utf8')
      expect(svg).toContain('<svg')
    }))
  })
})
