import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const defaultSource = resolve(root, 'apps/mobile/skins')
const defaultOutput = resolve(root, 'apps/mobile/android/build/generated/skins')
const skinIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
let compiler

export function loadSkinCompiler() {
  compiler ??= (async () => {
    const require = createRequire(resolve(root, 'apps/buddy/package.json'))
    const { runnerImport } = await import(require.resolve('vite'))
    const { z } = require('zod')
    const { module: source } = await runnerImport(fileURLToPath(new URL('./skins-source.ts', import.meta.url)), { configFile: false, root: resolve(root, 'apps/buddy') })
    const variant = z.object({ colors: z.record(z.string(), z.string()), home: z.record(z.string(), z.unknown()).nullable() }).strict()
    const schema = z.object({
      schemaVersion: z.literal(1),
      id: z.string().max(80).regex(skinIdPattern),
      version: z.number().int().min(1).max(2147483647),
      name: z.object({ zh: z.string().trim().min(1).max(160), en: z.string().trim().min(1).max(160) }).strict(),
      variants: z.object({ light: variant, dark: variant }).strict(),
    }).strict()
    return (input) => {
      const skin = schema.parse(input)
      return {
        ...skin,
        variants: Object.fromEntries(['light', 'dark'].map(mode => [mode, {
          palette: source.resolveSkinPalette(mode, skin.variants[mode].colors),
          home: skin.variants[mode].home,
        }])),
      }
    }
  })()
  return compiler
}

async function assetFiles(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink())
      throw new Error(`Skin assets cannot be symbolic links: ${path}`)
    if (!/^[\w-][\w.-]*$/.test(entry.name))
      throw new Error(`Invalid skin asset path: ${path}`)
    if (entry.isDirectory()) {
      result.push(...await assetFiles(resolve(directory, entry.name), path))
    }
    else if (entry.isFile()) {
      if (!prefix && entry.name === 'skin.json')
        continue
      if (!/\.(?:png|jpe?g|webp|svg|ttf|otf)$/i.test(entry.name) && entry.name !== 'OFL.txt')
        throw new Error(`Expected a skin image, font or license: ${path}`)
      result.push(path)
    }
    else {
      throw new Error(`Expected a regular skin asset: ${path}`)
    }
  }
  return result.sort()
}

function validateAssetReferences(skin, files) {
  const available = new Set(files)
  const validate = (path, extension) => {
    if (typeof path !== 'string' || !/^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(path) || !extension.test(path) || !available.has(path))
      throw new Error(`Missing or invalid skin asset in ${skin.id}: ${path}`)
  }
  for (const { home } of Object.values(skin.variants)) {
    for (const surface of Object.values(home?.surfaces ?? {})) {
      if (surface.image != null)
        validate(surface.image.path, /\.(?:png|jpe?g|webp)$/i)
    }
    for (const key of ['fontFamily', 'brandFontFamily']) {
      const path = home?.typography?.[key]
      if (path != null)
        validate(path, /\.(?:ttf|otf)$/i)
    }
  }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export async function exportBuiltinSkins({ sourceDirectory = defaultSource, outputDirectory = defaultOutput } = {}) {
  const sourceRoot = resolve(sourceDirectory)
  const outputRoot = resolve(outputDirectory)
  if (contains(sourceRoot, outputRoot) || contains(outputRoot, sourceRoot))
    throw new Error('Skin source and generated output directories must not overlap')
  if (!(await lstat(sourceRoot)).isDirectory())
    throw new Error('Skin source must be a directory, not a symbolic link')
  const compile = await loadSkinCompiler()
  const skins = []
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !skinIdPattern.test(entry.name))
      throw new Error(`Expected a skin directory: ${entry.name}`)
    const directory = resolve(sourceRoot, entry.name)
    const assets = await assetFiles(directory)
    const skin = compile(JSON.parse(await readFile(resolve(directory, 'skin.json'), 'utf8')))
    if (skin.id !== entry.name)
      throw new Error(`Skin id must match directory: ${entry.name}`)
    validateAssetReferences(skin, assets)
    skins.push({ skin, directory, assets })
  }
  if (!skins.some(({ skin }) => skin.id === 'paper'))
    throw new Error('The default paper skin is required')
  skins.sort((a, b) => a.skin.id === 'paper' ? -1 : b.skin.id === 'paper' ? 1 : a.skin.id.localeCompare(b.skin.id, 'en'))
  const index = { schemaVersion: 1, skins: skins.map(({ skin }) => skin.id) }
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(resolve(outputRoot, 'skins'), { recursive: true })
  for (const { skin, directory, assets } of skins) {
    const destination = resolve(outputRoot, 'skins', skin.id)
    await mkdir(destination, { recursive: true })
    await writeFile(resolve(destination, 'skin.json'), `${JSON.stringify(skin)}\n`)
    for (const asset of assets) {
      const target = resolve(destination, asset)
      await mkdir(resolve(target, '..'), { recursive: true })
      await copyFile(resolve(directory, asset), target)
    }
  }
  await writeFile(resolve(outputRoot, 'skins/index.json'), `${JSON.stringify(index)}\n`)
  return index
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exportBuiltinSkins({ outputDirectory: process.argv[2] }).then((index) => {
    process.stdout.write(`Exported ${index.skins.length} built-in skins\n`)
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
