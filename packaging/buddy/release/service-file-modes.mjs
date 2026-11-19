import { chmodSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function checkServiceFileModes(root, { normalize = false } = {}) {
  function visit(path) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink())
      return
    const directory = stat.isDirectory()
    if (!directory && !stat.isFile())
      throw new Error(`Unsupported service resource: ${path}`)
    const executable = directory || (stat.mode & 0o111) !== 0
    const required = executable ? 0o005 : 0o004
    if (normalize) {
      const mode = executable ? 0o755 : 0o644
      if ((stat.mode & 0o7777) !== mode)
        chmodSync(path, mode)
    }
    else if ((stat.mode & required) !== required) {
      throw new Error(`Service resource inaccessible to desktop users: ${path}`)
    }
    if (directory) {
      for (const name of readdirSync(path))
        visit(join(path, name))
    }
  }
  visit(root)
}
