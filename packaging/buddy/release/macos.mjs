import { execFileSync } from 'node:child_process'
import process from 'node:process'

export function macosSigningMode(environment = process.env) {
  const mode = environment.LEXORA_MACOS_SIGNING ?? 'ad-hoc'
  if (!['ad-hoc', 'developer-id'].includes(mode))
    throw new Error('LEXORA_MACOS_SIGNING must be ad-hoc or developer-id')
  return mode
}

export function requireMacosSigningEnvironment(environment = process.env) {
  if (macosSigningMode(environment) === 'ad-hoc')
    return
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!environment[name]?.trim())
      throw new Error(`Developer ID packaging requires ${name}`)
  }
}

export function notarizeMacosArtifact(path, environment = process.env) {
  if (macosSigningMode(environment) === 'ad-hoc')
    return
  requireMacosSigningEnvironment(environment)
  let result
  try {
    result = JSON.parse(execFileSync('xcrun', [
      'notarytool',
      'submit',
      path,
      '--wait',
      '--output-format',
      'json',
      '--apple-id',
      environment.APPLE_ID,
      '--password',
      environment.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id',
      environment.APPLE_TEAM_ID,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60_000 }))
  }
  catch {
    throw new Error('macOS disk image notarization failed')
  }
  if (result.status !== 'Accepted')
    throw new Error('macOS disk image notarization was not accepted')
  execFileSync('xcrun', ['stapler', 'staple', path], { stdio: 'inherit', timeout: 120_000 })
  execFileSync('xcrun', ['stapler', 'validate', path], { stdio: 'inherit', timeout: 120_000 })
}
