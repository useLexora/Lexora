import type { ExtensionSkillContribution } from '../../shared/extensions/extensionSkills'
import { posix } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const metadataSchema = z.object({
  name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
}).loose()

export function validateExtensionSkillFiles(files: ReadonlyMap<string, Uint8Array>, skills: readonly ExtensionSkillContribution[]): void {
  const names = new Set<string>()
  for (const skill of skills) {
    const bytes = files.get(skill.path)
    if (!bytes || bytes.byteLength > 256 * 1024)
      throw new Error('EXTENSION_SKILL_INVALID')
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
      const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(content)
      if (!match || !match[2]?.trim())
        throw new Error('EXTENSION_SKILL_INVALID')
      const metadata = metadataSchema.parse(parse(match[1]!))
      if (metadata.name !== posix.basename(posix.dirname(skill.path)) || names.has(metadata.name))
        throw new Error('EXTENSION_SKILL_INVALID')
      names.add(metadata.name)
    }
    catch {
      throw new Error('EXTENSION_SKILL_INVALID')
    }
  }
}
