import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { OPERATING_SYSTEM } from '../../../apps/buddy/shared/platform/identifiers.ts'
import { writeError, writeOutput } from '../../shared/cli-output.mjs'
import { resolveBuddyOutputPaths } from '../release/output-paths.mjs'
import { resolveBuildTarget } from '../release/targets.mjs'
import { verifyDesktopResources } from '../release/verify-package.mjs'
import { runDesktopSmoke } from './run-gui-smoke.mjs'

async function main() {
  const target = resolveBuildTarget()
  if (target.platform !== OPERATING_SYSTEM.Windows)
    throw new Error('Installed Windows smoke requires Windows')
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'zip': { type: 'boolean' }, 'require-sandbox': { type: 'boolean' } },
  })
  const [source] = positionals
  if (positionals.length !== 1 || !source || !isAbsolute(source))
    throw new Error('Usage: verify-windows-install.mjs <absolute-installed-directory|absolute-zip-path> [--zip] [--require-sandbox]')
  const packageRoot = resolveBuddyOutputPaths().package.desktop
  if (!values.zip && resolve(source).toLowerCase().startsWith(`${packageRoot.toLowerCase()}\\`))
    throw new Error('Install the NSIS package before running installed smoke')
  if (values.zip && !source.toLowerCase().endsWith('.zip'))
    throw new Error('Windows ZIP smoke requires a ZIP archive')

  const smokeRoot = await mkdtemp(join(tmpdir(), 'lexora-windows-smoke-'))
  const lexoraHome = join(smokeRoot, '用户 Data')
  const format = values.zip ? 'windows-zip' : 'nsis'
  let directory = values.zip ? join(smokeRoot, '免安装 App') : source
  try {
    if (values.zip) {
      execFileSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:LEXORA_VERIFY_ZIP -DestinationPath $env:LEXORA_VERIFY_DIRECTORY',
      ], {
        env: { ...process.env, LEXORA_VERIFY_ZIP: source, LEXORA_VERIFY_DIRECTORY: directory },
        stdio: 'inherit',
        timeout: 120_000,
      })
    }
    let executablePath = verifyWindowsDistribution(directory, target, format)
    const environment = {
      ...process.env,
      LEXORA_HOME: lexoraHome,
      LEXORA_DESKTOP_SMOKE_EXPECTED_FORMAT: format,
      LEXORA_DESKTOP_SMOKE_REQUIRE_SANDBOX: values['require-sandbox'] ? '1' : '0',
    }
    delete environment.ELECTRON_RUN_AS_NODE
    await runDesktopSmoke(executablePath, environment, 180_000)
    const marker = randomUUID()
    verifyDatabase(lexoraHome, marker, true)
    await runDesktopSmoke(executablePath, environment, 180_000)
    verifyDatabase(lexoraHome, marker)
    if (values.zip) {
      const relocated = join(smokeRoot, '移动后 App')
      await rename(directory, relocated)
      directory = relocated
      executablePath = verifyWindowsDistribution(directory, target, format)
      await runDesktopSmoke(executablePath, environment, 180_000)
      verifyDatabase(lexoraHome, marker)
    }
    writeOutput(`Windows ${format} Desktop: distribution, startup, database preservation, restart and shutdown passed${values.zip ? '; relocated application reused the same data root' : ''}`)
  }
  catch (error) {
    const diagnostics = await readFile(join(lexoraHome, 'logs', 'application.jsonl'), 'utf8').catch(() => '')
    if (diagnostics)
      writeError(`Windows ${format} smoke diagnostics:\n${diagnostics.slice(-32_768)}`)
    throw error
  }
  finally {
    await rm(smokeRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 250 })
  }
}

function verifyWindowsDistribution(directory, target, format) {
  const { executablePath } = verifyDesktopResources(directory, target.id)
  if (format === 'nsis' && !existsSync(join(directory, 'Uninstall Lexora Buddy.exe')))
    throw new Error('NSIS uninstall entry is missing from the installed directory')
  return executablePath
}

function verifyDatabase(lexoraHome, marker, initialize = false) {
  const database = new DatabaseSync(join(lexoraHome, 'buddy', 'buddy.sqlite3'), { readOnly: !initialize })
  try {
    if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new Error('Installed Windows database integrity check failed')
    if (!(Number(database.prepare('PRAGMA user_version').get()?.user_version) > 0))
      throw new Error('Installed Windows runtime did not initialize its database')
    if (initialize) {
      database.exec('CREATE TABLE windows_acceptance_fixture (marker TEXT NOT NULL)')
      database.prepare('INSERT INTO windows_acceptance_fixture (marker) VALUES (?)').run(marker)
    }
    else if (database.prepare('SELECT marker FROM windows_acceptance_fixture').get()?.marker !== marker) {
      throw new Error('Windows runtime did not preserve its database across restart or relocation')
    }
  }
  finally {
    database.close()
  }
}

void main().catch((error) => {
  writeError(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
