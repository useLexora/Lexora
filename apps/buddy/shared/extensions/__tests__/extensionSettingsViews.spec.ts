import { describe, expect, it } from 'vitest'
import { extensionManifestSchema } from '../extensionManifest'

const moduleId = 'tests.settings.module'
const viewId = 'tests.settings.view'
function manifest(module: Record<string, unknown> = {}, view: Record<string, unknown> = {}, groups: unknown[] = []) {
  return { schemaVersion: 1, id: 'tests.settings', name: 'Settings', version: '1.0.0', apiVersion: 3, engines: { lexora: '*' }, contributes: {
    settings: { modules: [{ id: moduleId, title: 'Models', view: viewId, section: 'integrations', ...module }], groups },
    views: [{ id: viewId, title: 'Models', entry: 'view.js', location: 'page', resource: 'none', ...view }],
  } }
}

describe('extension settings views', () => {
  it('keeps declarative modules in plugins and permits an owned integration view', () => {
    const ordinary = extensionManifestSchema.parse(manifest({ view: undefined, section: undefined }))
    expect(ordinary.contributes.settings.modules[0]?.section).toBe('plugins')
    expect(extensionManifestSchema.parse(manifest()).contributes.settings.modules[0]).toMatchObject({ section: 'integrations', view: viewId })
  })

  it('keeps experimental entry metadata optional without changing permissions or view ownership', () => {
    const ordinary = extensionManifestSchema.parse(manifest())
    const experimental = { platforms: ['darwin'] }
    const marked = extensionManifestSchema.parse(manifest({ experimental }))
    expect(ordinary.contributes.settings.modules[0]?.experimental).toBeUndefined()
    expect(marked.contributes.settings.modules[0]?.experimental).toEqual(experimental)
    expect(marked.permissions).toEqual(ordinary.permissions)
    expect(marked.contributes.views).toEqual(ordinary.contributes.views)
  })

  it('rejects unsupported or repeated platforms and extra experimental metadata', () => {
    for (const experimental of [
      { platforms: [] },
      { platforms: ['macOS'] },
      { platforms: ['darwin', 'darwin'] },
      { platforms: ['darwin'], description: '实验性功能' },
      { platforms: ['darwin'], status: 'beta' },
    ]) expect(extensionManifestSchema.safeParse(manifest({ experimental })).success).toBe(false)
  })

  it('rejects foreign, absent, resource-dependent and overlay views without granting extra surfaces', () => {
    for (const input of [
      manifest({ view: 'other.plugin.view' }),
      manifest({ view: 'tests.settings.missing' }),
      manifest({}, { resource: 'selected-file' }),
      manifest({}, { location: 'context' }),
      manifest({}, { location: 'window-overlay' }),
      manifest({ section: 'system' }),
      manifest({}, {}, [{ id: 'tests.settings.group', title: 'Group', module: moduleId }]),
    ]) expect(extensionManifestSchema.safeParse(input).success).toBe(false)
  })
})
