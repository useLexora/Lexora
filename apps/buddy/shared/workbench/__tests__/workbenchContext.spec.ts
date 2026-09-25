import { describe, expect, it } from 'vitest'
import { extensionManifestSchema } from '../../extensions/extensionManifest'
import { matchesWorkbenchContext, workbenchConditionSchema } from '../workbenchContext'

describe('contribution context conditions', () => {
  it('combines keys with AND and alternatives with strict equality', () => {
    const condition = { 'page.id': ['lexora.tasks', 'lexora.settings'], 'feature.enabled': true }
    expect(matchesWorkbenchContext(condition, { 'page.id': 'lexora.tasks', 'feature.enabled': true })).toBe(true)
    expect(matchesWorkbenchContext(condition, { 'page.id': 'lexora.settings', 'feature.enabled': 'true' })).toBe(false)
    expect(matchesWorkbenchContext(condition, { 'page.id': 'lexora.automations', 'feature.enabled': true })).toBe(false)
    expect(matchesWorkbenchContext({ missing: false }, {})).toBe(false)
    expect(matchesWorkbenchContext({ constructor: 'Object' }, {})).toBe(false)
    expect(matchesWorkbenchContext(undefined, {})).toBe(true)
    expect(matchesWorkbenchContext({}, {})).toBe(true)
  })

  it('bounds conditions without restricting future registered page identities', () => {
    expect(workbenchConditionSchema.parse({ 'page.id': 'future.canvas', 'page.mode': ['preview', 'edit'] })).toEqual({ 'page.id': 'future.canvas', 'page.mode': ['preview', 'edit'] })
    for (const value of [{ 'page.id': [] }, { 'page.id': Array.from({ length: 33 }).fill('tasks') }, { 'page.id': { equals: 'tasks' } }, { 'page.id': 'x'.repeat(257) }, { size: Infinity }, Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, true]))])
      expect(workbenchConditionSchema.safeParse(value).success).toBe(false)
  })

  it('preserves conditions through legacy mount normalization and manifest round trips', () => {
    const when = { 'page.id': ['lexora.tasks', 'future.canvas'] }
    const manifest = extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.context', name: 'Context', version: '1.0.0', apiVersion: 2, engines: { lexora: '*' }, entry: 'host.js', contributes: {
      commands: [{ id: 'tests.context.open', title: 'Open', when }],
      views: [{ id: 'tests.context.ui', title: 'UI', entry: 'ui.js', resource: 'none', when }],
      placements: [{ id: 'tests.context.surface', kind: 'view', location: 'workbench.bottom', view: 'tests.context.ui', when }],
      navigation: { title: 'Context', view: 'tests.context.ui', when },
    } })
    expect(manifest.contributes.placements[0]).toMatchObject({ target: 'workbench', when, presentation: { position: 'static', order: 1 } })
    expect(extensionManifestSchema.parse(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
  })
})
