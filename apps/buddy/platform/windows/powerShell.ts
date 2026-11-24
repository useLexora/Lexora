import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { validateWindowsFilePath } from './filePath'

const executeFile = promisify(execFile)

export class PowerShellUnavailableError extends Error {
  readonly code = 'POWERSHELL_UNAVAILABLE'

  constructor(options?: ErrorOptions) {
    super('No usable PowerShell installation was found. Install PowerShell 7 or restore Windows PowerShell.', options)
    this.name = 'PowerShellUnavailableError'
  }
}

interface WindowsPowerShellResolverOptions {
  environment: NodeJS.ProcessEnv
  isFile: (path: string) => Promise<boolean>
  probe: (path: string) => Promise<{ major: number, minor?: number, edition: string }>
}

export function createWindowsPowerShellResolver(options: WindowsPowerShellResolverOptions): () => Promise<string> {
  let resolution: Promise<string> | undefined
  return () => resolution ??= resolvePowerShell(options)
}

async function resolvePowerShell(options: WindowsPowerShellResolverOptions): Promise<string> {
  const environment = normalizeEnvironment(options.environment)
  const directories = [
    ...(environment.PROGRAMFILES ? [win32.join(environment.PROGRAMFILES, 'PowerShell', '7')] : []),
    ...(environment.PATH ?? '').split(';'),
  ]
  const candidates = new Map<string, string>()
  for (const directory of directories) {
    try {
      const root = validateWindowsFilePath(directory.replace(/^"|"$/g, ''))
      const candidate = win32.join(root, 'pwsh.exe')
      candidates.set(candidate.toLowerCase(), candidate)
    }
    catch {}
  }
  for (const candidate of candidates.values()) {
    if (!await options.isFile(candidate))
      continue
    try {
      const version = await options.probe(candidate)
      if (version.major === 7 && version.edition === 'Core')
        return candidate
    }
    catch {}
  }
  if (environment.SYSTEMROOT) {
    try {
      const legacy = win32.join(validateWindowsFilePath(environment.SYSTEMROOT), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      if (await options.isFile(legacy)) {
        const version = await options.probe(legacy)
        if (version.major === 5 && version.minor === 1 && version.edition === 'Desktop')
          return legacy
      }
    }
    catch {}
  }
  throw new PowerShellUnavailableError()
}

export function createWindowsHostEnvironment(executable: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = normalizeEnvironment(source)
  if (!environment.SYSTEMROOT)
    throw new Error('Windows system directory is unavailable')
  const systemRoot = validateWindowsFilePath(environment.SYSTEMROOT)
  const shellDirectory = win32.dirname(executable)
  return {
    SystemRoot: systemRoot,
    TEMP: environment.TEMP,
    TMP: environment.TMP,
    USERPROFILE: environment.USERPROFILE,
    LOCALAPPDATA: environment.LOCALAPPDATA,
    PATH: [shellDirectory, win32.join(systemRoot, 'System32')].join(';'),
    PSModulePath: win32.join(shellDirectory, 'Modules'),
    POWERSHELL_TELEMETRY_OPTOUT: '1',
  }
}

function normalizeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]))
}

export const resolveWindowsPowerShell = createWindowsPowerShellResolver({
  environment: process.env,
  isFile: path => stat(path).then(entry => entry.isFile(), () => false),
  async probe(path) {
    const result = await executeFile(path, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::Out.Write((\'{0}:{1}:{2}\' -f $PSVersionTable.PSVersion.Major,$PSVersionTable.PSVersion.Minor,$PSVersionTable.PSEdition))',
    ], {
      encoding: 'utf8',
      env: createWindowsHostEnvironment(path, process.env),
      maxBuffer: 4096,
      timeout: 10_000,
      windowsHide: true,
    })
    const match = /^(\d+):(\d+):(Core|Desktop)$/.exec(result.stdout)
    if (!match)
      throw new PowerShellUnavailableError()
    return { major: Number(match[1]), minor: Number(match[2]), edition: match[3]! }
  },
})
