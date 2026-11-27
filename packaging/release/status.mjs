import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { androidArtifact } from '../mobile/release/apk.mjs'
import { writeError, writeOutput } from '../shared/cli-output.mjs'
import { readLexoraVersionState, validateLexoraVersionState } from './version.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')

export function formatLexoraReleaseStatus(state, { android }) {
  return [
    `Lexora ${state.productVersion} 发布状态`,
    `Buddy    ${state.applicationVersions.buddy}  可构建、可发布`,
    'Mobile   随 Lexora Release 发布',
    `  Android  ${android.versionName} (versionCode ${android.versionCode})`,
    'Website  —      独立部署，不参与产品版本',
    'Web / API / Agent 暂停版本联动，等待重构',
  ].join('\n')
}

function main() {
  const state = readLexoraVersionState(repoRoot)
  const errors = validateLexoraVersionState(state)
  if (errors.length)
    throw new Error(errors.join('\n'))
  writeOutput(formatLexoraReleaseStatus(state, { android: androidArtifact(repoRoot) }))
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
