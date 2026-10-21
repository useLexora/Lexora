import type { ShellCandidate, ShellCandidateId, ShellProgram } from '../../shared/shell/shellProgram'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { shellCandidateIdSchema, shellProgramSchema } from '../../shared/shell/shellProgram'
import { createToolchainEnvironment } from './toolchainEnvironment'

const executeFile = promisify(execFile)
const definitions: Record<ShellCandidateId, { label: string, dialect: ShellProgram['dialect'], name: string }> = {
  'bash': { label: 'Bash', dialect: 'bash', name: 'bash' },
  'git-bash': { label: 'Git Bash', dialect: 'bash', name: 'bash' },
  'zsh': { label: 'Zsh', dialect: 'zsh', name: 'zsh' },
  'sh': { label: 'POSIX sh', dialect: 'sh', name: 'sh' },
  'powershell7': { label: 'PowerShell 7+', dialect: 'powershell', name: 'pwsh' },
  'powershell51': { label: 'Windows PowerShell 5.1', dialect: 'powershell', name: 'powershell' },
  'cmd': { label: 'Command Prompt', dialect: 'cmd', name: 'cmd' },
}

export function buildShellInvocation(program: ShellProgram, command: string): { shell: string, args: string[], command: string } {
  shellProgramSchema.parse({ dialect: program.dialect, executable: program.executable })
  if (!command || command.includes('\0'))
    throw new Error('Invalid shell command')
  let args: string[]
  switch (program.dialect) {
    case 'bash':
      args = ['--noprofile', '--norc', '-c']
      break
    case 'zsh':
      args = ['-f', '-c']
      break
    case 'sh':
      args = ['-c']
      break
    case 'powershell':
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']
      command = Buffer.from(command, 'utf16le').toString('base64')
      break
    case 'cmd':
      if (/[\r\n]/.test(command))
        throw new Error('CMD_MULTILINE_UNSUPPORTED: use a single-line command or select another shell')
      args = ['/d', '/s', '/c']
      break
  }
  return { shell: program.executable, args, command }
}

export function createShellProgramEnvironment(program: ShellProgram, source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const forbidden = new Set(['BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELLOPTS', 'BASHOPTS'])
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    const key = platform === 'win32' ? name.toUpperCase() : name
    if (!forbidden.has(key) && !key.startsWith('BASH_FUNC_') && !value?.startsWith('()'))
      environment[key] = value
  }
  if (platform === 'win32' && ['bash', 'zsh', 'sh'].includes(program.dialect)) {
    const roots = windowsShellRuntimeDirectories(program.executable)
    environment.PATH = [...new Set([...roots, ...(environment.PATH ?? '').split(';')].filter(Boolean))].join(';')
  }
  return environment
}

export function windowsShellRuntimeDirectories(executable: string): string[] {
  const directory = win32.dirname(executable)
  const parent = win32.dirname(directory)
  const root = win32.basename(parent).toLowerCase() === 'usr' ? win32.dirname(parent) : parent
  return [...new Set([directory, win32.join(root, 'usr', 'bin'), win32.join(root, 'mingw64', 'bin')])]
}

export async function detectShellPrograms(options: { configured?: Partial<Record<ShellCandidateId, string>>, signal?: AbortSignal } = {}): Promise<ShellCandidate[]> {
  options.signal?.throwIfAborted()
  return Promise.all(shellCandidateIdSchema.options.map(async (id): Promise<ShellCandidate> => {
    const definition = definitions[id]
    const unavailable = (reason: string, executable = ''): ShellCandidate => ({ id, label: definition.label, dialect: definition.dialect, executable, version: '', available: false, reason })
    const configured = options.configured?.[id]
    if (configured !== undefined && (!isAbsolute(configured) || configured.startsWith('\\\\') || configured.includes('\0')))
      return unavailable('The configured executable must be an absolute local path')
    if (process.platform !== 'win32' && ['git-bash', 'powershell51', 'cmd'].includes(id))
      return unavailable('Not supported on this operating system')
    const candidates = configured !== undefined ? [configured] : candidatePaths(id)
    for (const path of candidates) {
      options.signal?.throwIfAborted()
      try {
        if (!await usableExecutable(path, definition.dialect))
          continue
        const version = await probe(path, id, options.signal)
        return { id, label: definition.label, dialect: definition.dialect, executable: path, version, available: true }
      }
      catch {
        options.signal?.throwIfAborted()
        return unavailable('The executable failed its bounded version probe', path)
      }
    }
    return unavailable('No usable local installation was found')
  }))
}

function candidatePaths(id: ShellCandidateId): string[] {
  const windows = process.platform === 'win32'
  const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]))
  const paths: string[] = []
  if (windows) {
    if (id === 'git-bash' || id === 'bash') {
      for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')]) {
        if (root)
          paths.push(win32.join(root, 'Git', 'bin', 'bash.exe'), win32.join(root, 'Git', 'usr', 'bin', 'bash.exe'))
      }
    }
    if (id === 'powershell7' && env.PROGRAMFILES)
      paths.push(win32.join(env.PROGRAMFILES, 'PowerShell', '7', 'pwsh.exe'))
    if (env.SYSTEMROOT && id === 'powershell51')
      paths.push(win32.join(env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    if (env.SYSTEMROOT && id === 'cmd')
      paths.push(win32.join(env.SYSTEMROOT, 'System32', 'cmd.exe'))
  }
  else {
    paths.push(...['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/microsoft/powershell/7', '/opt/microsoft/powershell/7'].map(root => join(root, definitions[id].name)))
  }
  for (const root of (env.PATH ?? '').split(delimiter).slice(0, 128)) {
    const normalized = root.replace(/^"|"$/g, '')
    if (isAbsolute(normalized))
      paths.push(join(normalized, definitions[id].name + (windows ? '.exe' : '')))
  }
  return [...new Set(paths)]
}

async function usableExecutable(path: string, dialect: ShellProgram['dialect']): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile())
      return false
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    if (process.platform === 'win32') {
      const canonical = await realpath(path)
      if (canonical.startsWith('\\\\') || /\\(?:WindowsApps|System32|SysWOW64|Sysnative)\\(?:bash|sh|zsh)\.exe$/i.test(canonical))
        return false
      if (['bash', 'sh', 'zsh'].includes(dialect)) {
        const root = dirname(canonical)
        const runtimes = [join(root, 'msys-2.0.dll'), join(root, '..', 'usr', 'bin', 'msys-2.0.dll')]
        if (!(await Promise.all(runtimes.map(file => stat(file).then(info => info.isFile(), () => false)))).some(Boolean))
          return false
      }
    }
    return true
  }
  catch {
    return false
  }
}

async function probe(executable: string, id: ShellCandidateId, signal?: AbortSignal): Promise<string> {
  const { dialect } = definitions[id]
  let args: string[]
  if (dialect === 'powershell')
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Write($PSVersionTable.PSVersion.ToString())']
  else if (dialect === 'cmd')
    args = ['/d', '/s', '/c', 'ver']
  else if (dialect === 'sh')
    args = ['-c', 'printf "LEXORA_POSIX_SH"']
  else
    args = dialect === 'bash' ? ['--noprofile', '--norc', '--version'] : ['-f', '--version']
  const environment = createToolchainEnvironment(process.env, process.platform)
  for (const name of ['SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'PATH']) {
    const value = Object.entries(process.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    if (value)
      environment[name] = value
  }
  const { stdout } = await executeFile(executable, args, { env: environment, signal, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 8192, windowsHide: true, encoding: 'utf8' })
  const version = stdout.trim()
  const valid = dialect === 'bash'
    ? /GNU bash, version \d/i.test(version)
    : dialect === 'zsh'
      ? /^zsh \d/i.test(version)
      : dialect === 'sh'
        ? version === 'LEXORA_POSIX_SH'
        : dialect === 'cmd'
          ? /\d+\.\d+/.test(version)
          : id === 'powershell51' ? /^5\.1\./.test(version) : Number.parseInt(version) >= 7
  if (!valid)
    throw new Error('Unexpected shell version')
  return dialect === 'sh' ? 'POSIX sh (version not reported)' : version.split(/[\r\n]/)[0]!.slice(0, 256)
}
