import type { z } from 'zod'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { buildExtensionPackage } from '../buildExtensionPackage'
import { compileExtensionSource } from '../compileExtensionSource'
import { unpackExtension } from '../extensionFiles'
import { ExtensionPackageStore } from '../ExtensionPackageStore'

const id = 'tests.workbook'
const skillPath = 'skills/workbook/SKILL.md'
const skillContent = '---\nname: workbook\ndescription: Inspect spreadsheet files.\nlicense: Apache-2.0\n---\n\nRead references/workbook.md before running scripts/inspect.ts.\n'
const roots: string[] = []

function manifest(patch: Partial<z.input<typeof extensionManifestSchema>> = {}): z.input<typeof extensionManifestSchema> {
  return { schemaVersion: 1, id, name: 'Workbook', version: '1.0.0', apiVersion: 4, engines: { lexora: '>=0.15.0' }, contributes: { skills: [{ id: `${id}.guide`, path: skillPath }] }, ...patch }
}

function files(input = manifest(), content: Record<string, string | Uint8Array> = {}) {
  return new Map(Object.entries({ 'extension.json': JSON.stringify(input), [skillPath]: skillContent, ...content }).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]))
}

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-extension-skills-'))
  roots.push(root)
  const store = new ExtensionPackageStore(join(root, 'extensions'), '0.15.0')
  await store.load()
  return store
}

async function build(input: Map<string, Uint8Array>) {
  return buildExtensionPackage({ archive: Buffer.from(zipSync(Object.fromEntries(input))).toString('base64') }, (files, manifest, _signal, report) => compileExtensionSource(files, manifest, report), new AbortController().signal)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('packaged skill contract', () => {
  it('installs and reloads a skills-only package without an executable entry or permissions', async () => {
    const current = await store()
    const review = await current.reviewFiles(files())
    expect(review.manifest.entry).toBeUndefined()
    expect(review.addedPermissions).toEqual([])
    await current.install(review.token)
    const reloaded = new ExtensionPackageStore(current.root, '0.15.0')
    await reloaded.load()
    const installed = reloaded.installed[id]!.current
    expect(installed.manifest.contributes.skills).toEqual([{ id: `${id}.guide`, path: skillPath }])
    expect(new Uint8Array(await reloaded.asset(installed, skillPath))).toEqual(strToU8(skillContent))
  })

  it('rejects Skills declarations before API 4', () => {
    expect(extensionManifestSchema.safeParse(manifest({ apiVersion: 3 })).success).toBe(false)
  })

  it.each([
    ['absent frontmatter', '# Workbook\nInstructions.'],
    ['invalid YAML', '---\nname: [\ndescription: Workbook\n---\nInstructions.'],
    ['empty description', '---\nname: workbook\ndescription: " "\n---\nInstructions.'],
    ['nonstandard name', '---\nname: Workbook\ndescription: Workbook\n---\nInstructions.'],
    ['name differs from directory', '---\nname: another\ndescription: Workbook\n---\nInstructions.'],
    ['empty body', '---\nname: workbook\ndescription: Workbook\n---\n'],
    ['invalid UTF-8', Uint8Array.from([0xFF, 0xFE, 0xFD])],
  ])('rejects %s during package review', async (_name, content) => {
    await expect((await store()).reviewFiles(files(manifest(), { [skillPath]: content }))).rejects.toThrow('EXTENSION_SKILL_INVALID')
  })

  it('rejects a missing declared Skill and duplicate standard names in distinct directories', async () => {
    const input = files()
    input.delete(skillPath)
    await expect((await store()).reviewFiles(input)).rejects.toThrow('EXTENSION_SKILL_INVALID')
    expect(await build(input)).toMatchObject({ ok: false, code: 'EXTENSION_SKILL_INVALID' })
    const duplicatePath = 'other/workbook/SKILL.md'
    const duplicate = files(manifest({ contributes: { skills: [{ id: `${id}.guide`, path: skillPath }, { id: `${id}.second`, path: duplicatePath }] } }), { [duplicatePath]: skillContent })
    await expect((await store()).reviewFiles(duplicate)).rejects.toThrow('EXTENSION_SKILL_INVALID')
  })

  it('rejects overlapping skill directories', () => {
    const input = manifest({ contributes: { skills: [{ id: `${id}.guide`, path: skillPath }, { id: `${id}.second`, path: 'skills/workbook/nested/SKILL.md' }] } })
    expect(extensionManifestSchema.safeParse(input).success).toBe(false)
  })

  it.each(['host', 'view'])('rejects a %s entry inside a Skill directory', (kind) => {
    const entry = 'skills/workbook/scripts/inspect.js'
    const input = kind === 'host'
      ? manifest({ entry })
      : manifest({ contributes: { skills: [{ id: `${id}.guide`, path: skillPath }], views: [{ id: `${id}.view`, title: 'Workbook', entry, resource: 'none' }] } })
    expect(extensionManifestSchema.safeParse(input).success).toBe(false)
  })

  it('preserves scripts, bare imports, references, declarations and binary assets byte for byte when compiling a Skills-only package', async () => {
    const resources = {
      'skills/workbook/scripts/inspect.ts': 'import XLSX from "xlsx";\nconst title: string = "workbook";\nexport { title, XLSX };\n',
      'skills/workbook/scripts/inspect.js': 'import fs from "node:fs/promises";\nexport default fs;\n',
      'skills/workbook/scripts/types.d.ts': 'export interface Workbook { rows: number }\n',
      'skills/workbook/references/workbook.md': '\uFEFF# Workbook\r\n\r\nPreserve the original bytes.\r\n',
      'skills/workbook/assets/sample.bin': Uint8Array.from([0, 255, 128, 64, 13, 10]),
    }
    const input = files(manifest({ format: 'source' }), resources)
    const result = await build(input)
    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.code)
    const output = unpackExtension(Buffer.from(result.archive, 'base64'))
    for (const name of [skillPath, ...Object.keys(resources)])
      expect(output.get(name), name).toEqual(input.get(name))
    const compiled = JSON.parse(new TextDecoder().decode(output.get('extension.json')))
    expect(compiled.entry).toBeUndefined()
    expect(compiled.contributes.skills).toEqual([{ id: `${id}.guide`, path: skillPath }])
  })

  it.each([
    ['host static import', 'host', 'import { value } from "./skills/workbook/scripts/helper.js"; export const activate = () => value'],
    ['view dynamic import', 'view', 'export const render = () => import("./skills/workbook/scripts/helper.js")'],
    ['host re-export', 'host', 'export { value as activate } from "./skills/workbook/scripts/helper.js"'],
  ])('prevents %s from executing a packaged Skill resource', async (_name, kind, source) => {
    const entry = `${kind}.ts`
    const input = manifest({ format: 'source', ...(kind === 'host'
      ? { entry }
      : { contributes: { skills: [{ id: `${id}.guide`, path: skillPath }], views: [{ id: `${id}.view`, title: 'Workbook', entry, resource: 'none' }] } }) })
    expect(await build(files(input, { [entry]: source, 'skills/workbook/scripts/helper.js': 'export const value = 1' }))).toMatchObject({ ok: false, code: 'EXTENSION_SOURCE_IMPORT_DENIED' })
  })
})
