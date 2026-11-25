import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { exportBuiltinSkins, loadSkinCompiler } from '../export-skins.mjs'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const sourceDirectory = resolve(root, 'apps/mobile/skins')
const require = createRequire(resolve(root, 'apps/buddy/package.json'))
const { runnerImport } = await import(require.resolve('vite'))
const load = async path => (await runnerImport(resolve(root, 'apps/buddy', path), { configFile: false, root: resolve(root, 'apps/buddy') })).module
const [{ resolveTheme }, { themeDocumentSchema }, { semanticColorTokens, themeFonts }, { markdownThemeVariables }] = await Promise.all([
  load('shared/theme/resolveTheme.ts'), load('shared/theme/themeDocument.ts'), load('shared/theme/themeTokens.ts'), load('src/theme/markdownTheme.ts'),
])
const compile = await loadSkinCompiler()
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const fixture = (id = 'paper') => ({
  schemaVersion: 1,
  id,
  version: 1,
  name: { zh: '测试皮肤', en: 'Test skin' },
  variants: { light: { colors: {}, home: null }, dark: { colors: {}, home: null } },
})
async function workspace(t) {
  const path = await mkdtemp(resolve(tmpdir(), 'lexora-skins-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
async function writeSkin(directory, skin) {
  const path = resolve(directory, skin.id)
  await mkdir(path, { recursive: true })
  await writeFile(resolve(path, 'skin.json'), JSON.stringify(skin))
  return path
}

function expectedPalette(mode, classic, overrides) {
  const document = themeDocumentSchema.parse({ ...classic, colors: { ...classic.colors, ...overrides } })
  const theme = resolveTheme({ id: `mobile-${mode}`, label: 'Lexora', appearance: mode, source: 'fallback', extensionId: null, packageName: '', swatch: '' }, document)
  return { colors: theme.colors, variables: {
    ...theme.variables,
    ...markdownThemeVariables(theme.colors),
    '--buddy-font-ui': themeFonts.ui,
    '--buddy-font-body': themeFonts.ui,
    '--buddy-font-mono': themeFonts.mono,
  } }
}

test('built-in packages contain complete native and reader palettes for both appearances and preserve paper', async (t) => {
  const outputDirectory = resolve(await workspace(t), 'generated')
  const index = await exportBuiltinSkins({ sourceDirectory, outputDirectory })
  assert.deepEqual(await json(resolve(outputDirectory, 'skins/index.json')), index)
  assert.equal(index.schemaVersion, 1)
  assert.equal(index.skins[0], 'paper')
  for (const id of ['paper', 'color-play', 'mecha-armor'])
    assert.ok(index.skins.includes(id), `Missing bundled skin ${id}`)
  for (const id of index.skins) {
    const input = await json(resolve(sourceDirectory, id, 'skin.json'))
    const output = await json(resolve(outputDirectory, 'skins', id, 'skin.json'))
    assert.equal(output.id, id)
    assert.equal(output.version, input.version)
    assert.deepEqual(output.name, input.name)
    for (const mode of ['light', 'dark']) {
      const classic = await json(resolve(root, `apps/buddy/extensions/bundled/lexora.themes/themes/classic-${mode}.json`))
      const { palette, home } = output.variants[mode]
      assert.deepEqual(home, input.variants[mode].home)
      assert.equal(output.variants[mode].connectionSignal, input.variants[mode].connectionSignal)
      const newTask = output.variants[mode].newTask
      assert.deepEqual(newTask, input.variants[mode].newTask)
      if (['paper', 'color-play', 'mecha-armor'].includes(id))
        assert.notEqual(newTask.illustration, output.variants[mode === 'light' ? 'dark' : 'light'].newTask.illustration)
      const assets = [
        ...(newTask ? [newTask.illustration] : []),
        ...Object.values(home?.surfaces ?? {}).flatMap(surface => surface.image ? [surface.image.path] : []),
        ...['fontFamily', 'brandFontFamily'].flatMap(key => home?.typography?.[key] ? [home.typography[key], 'fonts/OFL.txt'] : []),
      ]
      for (const asset of new Set(assets))
        assert.deepEqual(await readFile(resolve(outputDirectory, 'skins', id, asset)), await readFile(resolve(sourceDirectory, id, asset)))
      assert.deepEqual(Object.keys(palette.colors).sort(), Object.keys(semanticColorTokens).sort())
      assert.deepEqual(palette, expectedPalette(mode, classic, input.variants[mode].colors))
      for (const [key, variable] of Object.entries(semanticColorTokens)) {
        assert.match(palette.colors[key], /^#[\da-f]{6}(?:[\da-f]{2})?$/i)
        assert.equal(palette.variables[variable], palette.colors[key], `${id}.${mode}.${key}`)
      }
      for (const [key, value] of Object.entries(markdownThemeVariables(palette.colors)))
        assert.equal(palette.variables[key], value)
      if (id === 'paper')
        assert.deepEqual(palette, expectedPalette(mode, classic, {}))
    }
  }
})

test('source schema rejects unsupported versions, unsafe ids, malformed variants and colors', () => {
  const cases = [
    skin => skin.schemaVersion = 2,
    skin => skin.version = 0,
    skin => skin.version = 1.5,
    skin => skin.version = '1',
    skin => skin.id = '../escape',
    skin => skin.name.en = '',
    skin => delete skin.variants.dark,
    skin => skin.variants.light.home = [],
    skin => skin.variants.light.home = 'layout',
    skin => delete skin.variants.light.home,
    skin => skin.variants.light.connectionSignal = 'red',
    skin => skin.variants.light.colors = null,
    skin => skin.variants.light.colors.accent = '#123',
    skin => skin.variants.light.colors['not-a-token'] = '#112233',
    skin => skin.variants.light.palette = {},
  ]
  for (const change of cases) {
    const skin = fixture()
    change(skin)
    assert.throws(() => compile(skin), undefined, change.toString())
  }
})

test('new ids, opaque home data and local assets are discovered without code branches; only generated output is cleaned', async (t) => {
  const path = await workspace(t)
  const source = resolve(path, 'source')
  const output = resolve(path, 'generated')
  await writeSkin(source, fixture())
  const skin = fixture('aurora')
  skin.version = 2
  skin.variants.light.colors = { accent: '#123456', reading: '#faf0ee', link: '#345678', code: '#eeeaff' }
  skin.variants.light.home = { schemaVersion: 1, futureLayout: { image: 'images/cover.png' }, typography: { fontFamily: 'fonts/display.ttf' } }
  const skinPath = await writeSkin(source, skin)
  await writeSkin(source, fixture('zebra'))
  await mkdir(resolve(skinPath, 'images'))
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
  await writeFile(resolve(skinPath, 'images/cover.png'), bytes)
  await mkdir(resolve(skinPath, 'fonts'))
  const fontBytes = Buffer.from('00010000', 'hex')
  await writeFile(resolve(skinPath, 'fonts/display.ttf'), fontBytes)
  await writeFile(resolve(skinPath, 'fonts/OFL.txt'), 'Fixture font license')
  await mkdir(output)
  await writeFile(resolve(output, 'stale.json'), 'stale')
  await writeFile(resolve(path, 'other-build-output'), 'keep')
  assert.deepEqual(await exportBuiltinSkins({ sourceDirectory: source, outputDirectory: output }), { schemaVersion: 1, skins: ['paper', 'aurora', 'zebra'] })
  assert.deepEqual(await json(resolve(output, 'skins/aurora/skin.json')), compile(skin))
  assert.deepEqual(await readFile(resolve(output, 'skins/aurora/images/cover.png')), bytes)
  assert.deepEqual(await readFile(resolve(output, 'skins/aurora/fonts/display.ttf')), fontBytes)
  assert.equal(await readFile(resolve(output, 'skins/aurora/fonts/OFL.txt'), 'utf8'), 'Fixture font license')
  assert.equal(await readFile(resolve(path, 'other-build-output'), 'utf8'), 'keep')
  await assert.rejects(readFile(resolve(output, 'stale.json')), { code: 'ENOENT' })
})

test('invalid packages fail before replacing generated assets', async (t) => {
  const path = await workspace(t)
  const source = resolve(path, 'source')
  const output = resolve(path, 'generated')
  const paperPath = await writeSkin(source, fixture())
  await mkdir(output)
  await writeFile(resolve(output, 'previous'), 'keep')
  const run = () => exportBuiltinSkins({ sourceDirectory: source, outputDirectory: output })
  await writeFile(resolve(paperPath, 'run.js'), 'invalid asset')
  await assert.rejects(run, /Expected a skin image/)
  await rm(resolve(paperPath, 'run.js'))
  await symlink(resolve(output, 'previous'), resolve(paperPath, 'outside.png'))
  await assert.rejects(run, /symbolic links/)
  await rm(resolve(paperPath, 'outside.png'))
  for (const home of [
    { surfaces: { hero: { image: { path: 'images/missing.webp' } } } },
    { surfaces: { hero: { image: { path: '../outside.png' } } } },
    { typography: { fontFamily: 'fonts/missing.ttf' } },
  ]) {
    const skin = fixture()
    skin.variants.light.home = home
    await writeFile(resolve(paperPath, 'skin.json'), JSON.stringify(skin))
    await assert.rejects(run, /Missing or invalid skin asset/)
    assert.equal(await readFile(resolve(output, 'previous'), 'utf8'), 'keep')
  }
  const missingArt = fixture()
  missingArt.variants.light.newTask = { illustration: 'images/missing.webp', widthFraction: 0.5, corners: 'cut', outline: '#889099', underlay: '#171B21', offset: 1 }
  await writeFile(resolve(paperPath, 'skin.json'), JSON.stringify(missingArt))
  await assert.rejects(run, /Missing or invalid skin asset/)
  assert.equal(await readFile(resolve(output, 'previous'), 'utf8'), 'keep')
  await writeFile(resolve(paperPath, 'skin.json'), JSON.stringify(fixture('different-id')))
  await assert.rejects(run, /must match directory/)
  await rm(paperPath, { recursive: true })
  await writeSkin(source, fixture('aurora'))
  await assert.rejects(run, /paper skin is required/)
  assert.equal(await readFile(resolve(output, 'previous'), 'utf8'), 'keep')
  await assert.rejects(exportBuiltinSkins({ sourceDirectory: source, outputDirectory: path }), /must not overlap/)
})
