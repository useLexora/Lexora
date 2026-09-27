import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'

export const MAX_SKILL_BYTES = 256 * 1024
export const MAX_SKILL_PACKAGE_BYTES = 64 * 1024 * 1024
export const MAX_SKILL_FILES = 5000

export class SkillError extends Error {
  readonly code: 'SKILL_NOT_FOUND' | 'SKILL_CHANGED' | 'SKILL_INVALID' | 'SKILL_TOO_LARGE' | 'SKILL_BUSY' | 'SKILL_READ_ONLY' | 'SKILL_INSTALL_FAILED' | 'SKILL_SOURCE_UNAVAILABLE' | 'SKILL_PREVIEW_EXPIRED' | 'SKILL_NAME_COLLISION'

  constructor(code: SkillError['code'], options?: ErrorOptions) {
    super(code, options)
    this.name = 'SkillError'
    this.code = code
  }
}

export function skillIdentity(value: string): string {
  return `skill-${createHash('sha256').update(value).digest('hex')}`
}

export function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export async function requireSkillPath(root: string, path: string): Promise<string> {
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)])
  if (!isWithin(canonicalRoot, canonicalPath))
    throw new SkillError('SKILL_INVALID')
  return canonicalPath
}

export async function discoverSkillFiles(root: string, allowLooseFiles = false, onInvalid?: (path: string) => void): Promise<string[]> {
  const canonicalRoot = await realpath(root)
  const seen = new Set<string>()
  const files: string[] = []
  let entriesSeen = 0
  async function visit(path: string, depth: number) {
    if (depth > 16 || ++entriesSeen > MAX_SKILL_FILES)
      throw new SkillError('SKILL_TOO_LARGE')
    const canonical = await requireSkillPath(canonicalRoot, path)
    if (seen.has(canonical))
      return
    seen.add(canonical)
    const entries = await readdir(canonical, { withFileTypes: true })
    const declared = entries.find(entry => entry.name === 'SKILL.md')
    if (declared) {
      files.push(join(canonical, declared.name))
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules' || (entry.name.startsWith('.') && !['.agents', '.pi', '.claude'].includes(entry.name)))
        continue
      const next = join(canonical, entry.name)
      try {
        const metadata = entry.isSymbolicLink() ? await lstat(await requireSkillPath(canonicalRoot, next)) : entry
        if (metadata.isDirectory())
          await visit(next, depth + 1)
        else if (allowLooseFiles && depth === 0 && entry.name.endsWith('.md'))
          files.push(await requireSkillPath(canonicalRoot, next))
      }
      catch (error) {
        if (error instanceof SkillError && error.code === 'SKILL_TOO_LARGE')
          throw error
        onInvalid?.(next)
      }
    }
  }
  await visit(canonicalRoot, 0)
  return files
}

export async function readSkillFiles(root: string) {
  const canonical = await realpath(root)
  const files = new Map<string, Buffer>()
  const modes = new Map<string, number>()
  let bytes = 0
  let count = 0
  async function visit(path: string, depth: number) {
    if (depth > 16)
      throw new SkillError('SKILL_TOO_LARGE')
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git')
        continue
      if (++count > MAX_SKILL_FILES)
        throw new SkillError('SKILL_TOO_LARGE')
      const target = join(path, entry.name)
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new SkillError('SKILL_INVALID')
      if (entry.isDirectory()) {
        await visit(target, depth + 1)
        continue
      }
      const metadata = await lstat(target)
      bytes += metadata.size
      if (bytes > MAX_SKILL_PACKAGE_BYTES || files.size >= MAX_SKILL_FILES)
        throw new SkillError('SKILL_TOO_LARGE')
      const content = await readBoundedFile(canonical, target, MAX_SKILL_PACKAGE_BYTES)
      if (content.length !== metadata.size)
        throw new SkillError('SKILL_CHANGED')
      const name = relative(canonical, target).split(sep).join('/')
      files.set(name, content)
      modes.set(name, (metadata.mode & 0o111) ? 0o700 : 0o600)
    }
  }
  await visit(canonical, 0)
  return { files, modes }
}

export function hashSkillFiles(files: ReadonlyMap<string, Uint8Array>, modes: ReadonlyMap<string, number>): string {
  const hash = createHash('sha256')
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(name).update('\0').update(content).update('\0').update(String(modes.get(name) ?? 0o600))
  return hash.digest('hex')
}

export async function readSkillDocument(filePath: string, allowedRoot = dirname(filePath)) {
  const path = await requireSkillPath(allowedRoot, filePath)
  if ((await lstat(path)).size > MAX_SKILL_BYTES)
    throw new SkillError('SKILL_TOO_LARGE')
  const content = await readBoundedFile(allowedRoot, path, MAX_SKILL_BYTES)
  if (content.length > MAX_SKILL_BYTES)
    throw new SkillError('SKILL_TOO_LARGE')
  const text = content.toString('utf8')
  let parsed: { frontmatter: Record<string, unknown>, body: string }
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(text)
  }
  catch { parsed = { frontmatter: {}, body: text } }
  const { frontmatter, body } = parsed
  const name = typeof frontmatter.name === 'string' && frontmatter.name ? frontmatter.name : (basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md'))
  return {
    name,
    hasDeclaredName: typeof frontmatter.name === 'string' && !!frontmatter.name.trim(),
    description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
    content: text,
    referenceRevision: createHash('sha256').update(content).digest('hex'),
    body: body.trim(),
    metadata: Object.entries(frontmatter).map(([name, value]) => ({ name, value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '' })),
    path,
    baseDirectory: dirname(path),
    manualOnly: frontmatter['disable-model-invocation'] === true,
    compatibility: typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility : null,
  }
}

export async function readSkill(filePath: string, allowedRoot = dirname(filePath)) {
  const document = await readSkillDocument(filePath, allowedRoot)
  const { path } = document
  if (!document.description)
    throw new SkillError('SKILL_INVALID')
  const { files, modes } = basename(path) === 'SKILL.md'
    ? await readSkillFiles(dirname(path))
    : { files: new Map([[basename(path), await readBoundedFile(allowedRoot, path, MAX_SKILL_BYTES)]]), modes: new Map([[basename(path), 0o600]]) }
  if (files.get(basename(path))?.toString('utf8') !== document.content)
    throw new SkillError('SKILL_CHANGED')
  return {
    ...document,
    revision: hashSkillFiles(files, modes),
    files,
    modes,
  }
}

export type LoadedSkill = Awaited<ReturnType<typeof readSkill>>
