import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { parseLexoraVersion } from '../../release/version.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')

export function androidArtifact(cwd = repoRoot) {
  const properties = join(cwd, 'apps/mobile/android/version.properties')
  const { versionName, versionCode: rawCode } = parseEnv(readFileSync(properties, 'utf8'))
  parseLexoraVersion(versionName)
  const versionCode = Number(rawCode)
  if (!/^\d+$/.test(rawCode ?? '') || versionCode < 1 || versionCode > 2_100_000_000)
    throw new Error('Invalid Android versionCode in version.properties')

  const name = `Lexora-Android-${versionName}.apk`
  const directory = join(cwd, 'apps/mobile/android/build/outputs/apk/release')
  return {
    name,
    path: join(directory, name),
    sourcePath: join(directory, 'android-release.apk'),
    artifact: 'lexora-android-apk',
    applicationId: 'app.uselexora.mobile',
    versionName,
    versionCode,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'github-output': { type: 'string' } } })
  if (!values['github-output'])
    throw new Error('Usage: apk.mjs --github-output <path>')
  const { path, sourcePath, artifact, applicationId, versionName, versionCode } = androidArtifact()
  appendFileSync(values['github-output'], [
    `path=${path}`,
    `source-path=${sourcePath}`,
    `artifact=${artifact}`,
    `application-id=${applicationId}`,
    `version-name=${versionName}`,
    `version-code=${versionCode}`,
    '',
  ].join('\n'))
}
