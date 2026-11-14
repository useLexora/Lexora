import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import nodeRuntime from '../../../apps/buddy/platform/native/nodeRuntime.json' with { type: 'json' }
import { createReleaseSet, hashReleaseFile, readReleaseSet } from '../../../apps/buddy/platform/service/releaseSet.ts'
import { resolveBuildTarget } from './targets.mjs'

export async function writeFileInventory(directory, output, excluded = []) {
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (path === output || excluded.includes(path))
        continue
      const name = relative(directory, path).split(sep).join('/')
      if (entry.isDirectory()) {
        await visit(path)
      }
      else if (entry.isSymbolicLink()) {
        const target = await readlink(path)
        const resolved = relative(directory, resolve(dirname(path), target))
        if (isAbsolute(target) || isAbsolute(resolved) || resolved === '..' || resolved.startsWith(`..${sep}`))
          throw new Error(`Release link escapes component: ${name}`)
        files.push({ path: name, link: target.split(sep).join('/') })
      }
      else if (entry.isFile()) {
        const stat = await lstat(path)
        files.push({ path: name, size: stat.size, sha256: await hashReleaseFile(path) })
      }
      else {
        throw new Error(`Unsupported release resource: ${name}`)
      }
    }
  }
  await visit(directory)
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  await writeFile(output, `${JSON.stringify({ version: 1, files }, null, 2)}\n`)
}

export async function refreshCoreInventory(directory) {
  const manifestPath = join(directory, 'resources.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const inventory = join(directory, 'inventory.json')
  await writeFileInventory(directory, inventory, [manifestPath])
  manifest.inventory = { path: 'inventory.json', sha256: await hashReleaseFile(inventory) }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function writeProductReleaseSet({ resourcesRoot, coreDirectory, hostPath, hostKind, nodeDirectory, target, productVersion }) {
  const coreManifest = join(coreDirectory, 'resources.json')
  const manifest = createReleaseSet({
    version: 1,
    productVersion,
    target: target.id,
    core: { entry: relative(resourcesRoot, join(coreDirectory, 'service.mjs')).replaceAll('\\', '/'), manifest: relative(resourcesRoot, coreManifest).replaceAll('\\', '/'), manifestSha256: await hashReleaseFile(coreManifest) },
    node: { entry: relative(resourcesRoot, join(nodeDirectory, nodeRuntime.targets[target.id].binary)).replaceAll('\\', '/'), version: nodeRuntime.version, archiveSha256: nodeRuntime.targets[target.id].sha256, binarySha256: await hashReleaseFile(join(nodeDirectory, nodeRuntime.targets[target.id].binary)) },
    host: { kind: hostKind, path: relative(resourcesRoot, hostPath).replaceAll('\\', '/'), sha256: await hashReleaseFile(hostPath) },
  })
  await writeFile(join(resourcesRoot, 'release-set.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function writePackagedReleaseSet(context) {
  const target = resolveBuildTarget()
  const resourcesRoot = join(context.appOutDir, target.platform === 'darwin' ? `${context.packager.appInfo.productFilename}.app/Contents/Resources` : 'resources')
  await refreshCoreInventory(join(resourcesRoot, 'lexora-service'))
  await writeProductReleaseSet({ resourcesRoot, coreDirectory: join(resourcesRoot, 'lexora-service'), hostPath: join(resourcesRoot, 'app.asar'), hostKind: 'asar', nodeDirectory: join(resourcesRoot, 'lexora-runtime'), target, productVersion: context.packager.appInfo.version })
}

export async function signMacosReleaseSet(options, packager) {
  const require = createRequire(fileURLToPath(new URL('../../../apps/buddy/package.json', import.meta.url)))
  const builder = createRequire(require.resolve('electron-builder'))
  const { sign } = builder('app-builder-lib/out/codeSign/macCodeSign.js')
  await sign(options)
  await writePackagedReleaseSet({ appOutDir: dirname(options.app), packager })
  await sign({ ...options, preAutoEntitlements: false, binaries: [], ignore: [path => resolve(path) !== resolve(options.app)] })
}

async function main() {
  if (process.argv[2] === '--verify') {
    if (process.argv.length !== 6)
      throw new Error('Usage: product-release-set.mjs --verify <manifest> <target> <version>')
    const release = await readReleaseSet(process.argv[3])
    if (release.manifest.target !== process.argv[4] || release.manifest.productVersion !== process.argv[5])
      throw new Error('Release set target/version mismatch')
    process.stdout.write(`${release.manifest.buildId}\n`)
    return
  }
  const target = resolveBuildTarget()
  const buddy = fileURLToPath(new URL('../../../apps/buddy/', import.meta.url))
  const output = join(buddy, '.output')
  const hostPath = join(output, 'build/electron/inventory.json')
  await writeFileInventory(join(output, 'build/electron'), hostPath)
  const { version } = JSON.parse(await readFile(join(buddy, 'buddy.version.json'), 'utf8'))
  const manifest = await writeProductReleaseSet({ resourcesRoot: output, coreDirectory: join(output, 'build/service'), hostPath, hostKind: 'inventory', nodeDirectory: join(output, 'resources/node-runtime', target.id), target, productVersion: version })
  process.stdout.write(`${manifest.buildId}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
