import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writeError, writeOutput } from '../shared/cli-output.mjs'
import { readLexoraVersionState, validateLexoraReleaseTag } from './version.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const draftMarker = '<!-- release-notes:draft -->'

export function releaseNotesPath(version) {
  validateLexoraReleaseTag(`v${version}`, version)
  return `.github/release-notes/v${version}.md`
}

export function createReleaseNotesDraft(generatedNotes) {
  const source = generatedNotes.trim().replace(/^(#{1,5}) /gm, '#$1 ')
  return `${draftMarker}
<!--
以下自动生成的条目是评审素材。整理为面向用户的中文说明，并补齐顺序一致的英文。
按需使用三级标题：升级提醒 / Upgrade notes、新增 / Added、改进 / Improved、修复 / Fixed；省略空分类。
合并重复改动，说明用户可感知的结果；涉及平台限制、升级操作或破坏性变化时在两种语言中明确写出。
完成人工评审后，删除草稿标记和说明注释。
-->
## 中文

${source}

## English

<!-- Write the English translation with the same scope and entry order as the reviewed Chinese notes. -->
`
}

export function validateReleaseNotes(notes) {
  const errors = []
  if (notes.includes(draftMarker))
    errors.push('release notes are still a draft; complete the bilingual review and remove the draft marker')
  const content = notes.replace(/<!--[\s\S]*?-->/g, '').trim()
  const sections = content.split(/^## (中文|English)\s*$/m)
  if (sections.length !== 5 || sections[0].trim() || sections[1] !== '中文' || sections[3] !== 'English')
    errors.push('release notes must contain exactly two language sections: ## 中文 followed by ## English')
  else if (!sections[2].trim() || !sections[4].trim())
    errors.push('both Chinese and English release notes must be non-empty')
  return errors
}

function main() {
  const [action, input, ...extra] = process.argv.slice(2)
  const version = readLexoraVersionState().productVersion
  const path = resolve(repoRoot, releaseNotesPath(version))
  if (action === '--prepare' && input && extra.length === 0) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, createReleaseNotesDraft(readFileSync(input, 'utf8')), { flag: 'wx' })
    writeOutput(`Created release notes draft: ${releaseNotesPath(version)}`)
    return
  }
  if (action !== '--check' || input)
    throw new Error('usage: notes.mjs --prepare <generated-notes-file> | --check')
  const errors = validateReleaseNotes(readFileSync(path, 'utf8'))
  if (errors.length)
    throw new Error(errors.join('\n'))
  writeOutput(`Release notes check passed: v${version}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  }
  catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
