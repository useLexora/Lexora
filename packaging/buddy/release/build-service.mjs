import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeOutput } from '../../shared/cli-output.mjs'
import { nativeHostResources, prepareNativeHost } from './native-host.mjs'
import { excludedDependencyFiles, platformSkills } from './platform-definition.mjs'
import { writeFileInventory } from './product-release-set.mjs'
import { prepareSearchTools, resolveSearchTools } from './search-tools.mjs'
import { checkServiceFileModes } from './service-file-modes.mjs'
import { resolveBuildTarget } from './targets.mjs'

export function servicePackageFile(pkg, path, excluded) {
  if (posix.basename(path) === 'node_modules' || /\.(?:[cm]?js|d\.[cm]?ts)\.map$/.test(path))
    return false
  if (/^@(?:aws-sdk|smithy)\//.test(pkg.name) && pkg.types?.startsWith('./dist-types/') && path.startsWith('dist-types/') && path.endsWith('.d.ts'))
    return false
  if (pkg.name === '@earendil-works/pi-tui' && path.endsWith('.node'))
    return !excluded.some(pattern => posix.matchesGlob(`node_modules/${pkg.name}/${path}`, pattern))
  return true
}

async function main() {
  const buddy = fileURLToPath(new URL('../../../apps/buddy/', import.meta.url))
  const requireBuddy = createRequire(join(buddy, 'package.json'))
  const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
  const output = join(buddy, '.output/build/service')
  const target = resolveBuildTarget(`${process.platform}-${process.arch}`)
  const excluded = excludedDependencyFiles(target).map(pattern => pattern.slice(1))
  const searchDirectory = await prepareSearchTools()
  prepareNativeHost(target)
  await build({ root: buddy, configFile: join(buddy, 'service.vite.config.ts') })
  const files = (await readdir(output, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(output, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
  const roots = JSON.parse(await readFile(join(output, 'dependencies.json'), 'utf8'))
  const copied = new Map()

  async function resolvePackage(name, owner, optional) {
    const resolver = createRequire(join(owner, 'package.json'))
    for (const directory of resolver.resolve.paths(name) ?? []) {
      try {
        return await realpath(join(directory, name))
      }
      catch (error) {
        if (error.code !== 'ENOENT')
          throw error
      }
    }
    if (!optional)
      throw new Error(`Missing service dependency: ${name}`)
  }

  async function copyPackage(source) {
    if (copied.has(source))
      return copied.get(source).directory
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    const directory = join(output, 'packages', `${pkg.name.replaceAll('/', '+')}@${pkg.version}-${copied.size}`)
    copied.set(source, { name: pkg.name, version: pkg.version, directory })
    await cp(source, directory, { recursive: true, verbatimSymlinks: true, filter: path => servicePackageFile(pkg, relative(source, path).split(sep).join('/'), excluded) })
    for (const name of Object.keys({ ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.dependencies })) {
      const dependency = await resolvePackage(name, source, Boolean(pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional))
      if (!dependency)
        continue
      await linkPackage(join(directory, 'node_modules', name), await copyPackage(dependency))
    }
    return directory
  }

  async function linkPackage(link, target) {
    await mkdir(dirname(link), { recursive: true })
    await symlink(relative(dirname(link), target), link, 'dir')
  }

  for (const name of roots)
    await linkPackage(join(output, 'node_modules', name), await copyPackage(await resolvePackage(name, join(buddy, 'service'), false)))

  const bundled = await Promise.all(files.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(output, path))).digest('hex') })))
  const resources = []
  async function resource(from, to) {
    const destination = join(output, 'resources', to)
    await mkdir(dirname(destination), { recursive: true })
    await cp(from, destination, { recursive: true })
    resources.push({ path: `resources/${to}`, sha256: createHash('sha256').update(await readFile(destination)).digest('hex') })
  }
  for (const component of nativeHostResources(target))
    await resource(join(buddy, component.from), component.to)
  for (const tool of resolveSearchTools(target.platform, target.architecture)) {
    await resource(join(searchDirectory, tool.binary), `search-tools/${tool.binary}`)
    for (const license of tool.licenses) {
      const path = `licenses/${tool.name}/${license}`
      await resource(join(searchDirectory, path), `search-tools/${path}`)
    }
  }
  const skills = platformSkills(target)
  for (const name of skills)
    await cp(join(buddy, 'service/resources/skills', name), join(output, 'resources/skills', name), { recursive: true })
  await writeFile(join(output, 'package.json'), `${JSON.stringify({ name: 'lexora-service', private: true, type: 'module', engines: { node: '>=26.2.0' } }, null, 2)}\n`)
  await writeFileInventory(output, join(output, 'inventory.json'), [join(output, 'resources.json')])
  const inventorySha256 = createHash('sha256').update(await readFile(join(output, 'inventory.json'))).digest('hex')
  await writeFile(join(output, 'resources.json'), `${JSON.stringify({ inventory: { path: 'inventory.json', sha256: inventorySha256 }, target: target.id, node: '>=26.2.0', entry: 'service.mjs', bundled, resources, skills, packages: [...copied.values()].map(({ name, version }) => ({ name, version })) }, null, 2)}\n`)
  if (target.platform !== 'win32')
    checkServiceFileModes(output, { normalize: true })
  writeOutput(`Lexora Server: ${output} (${copied.size} packages, ${resources.length} native/search/license resources)`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
