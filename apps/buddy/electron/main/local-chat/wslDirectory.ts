import { execFile } from 'node:child_process'

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

export interface WslDistributions {
  names: string[]
  defaultName: string | null
}

// Value of a `    Name    REG_SZ    value` line of `reg query`, or null for any other line.
function registryString(line: string, name: string): string | null {
  const [key, type, ...value] = line.trim().split(/\s+/)
  return key === name && type === 'REG_SZ' && value.length > 0 ? value.join(' ') : null
}

// Reads the installed distributions from the `reg query /s` output of the Lxss key; Docker Desktop's internal ones are not user directories.
export function parseWslDistributions(output: string): WslDistributions {
  const names = new Map<string, string>()
  let defaultGuid: string | null = null
  let guid: string | null = null
  for (const line of output.split(/\r?\n/)) {
    const key = /\\Lxss\\(\{[0-9a-f-]+\})\s*$/i.exec(line)
    if (key) {
      guid = key[1]!.toLowerCase()
      continue
    }
    if (/^HKEY_/i.test(line)) {
      guid = null
      continue
    }
    const fallback = registryString(line, 'DefaultDistribution')
    if (fallback) {
      defaultGuid = fallback.toLowerCase()
      continue
    }
    const name = registryString(line, 'DistributionName')
    if (name && guid)
      names.set(guid, name)
  }
  const visible = [...names].filter(([, name]) => !/^docker-desktop/i.test(name))
  const defaultName = visible.find(([id]) => id === defaultGuid)?.[1] ?? null
  return {
    // The default distribution comes first, as in `wsl --list`.
    names: visible.map(([, name]) => name).sort((left, right) => Number(right === defaultName) - Number(left === defaultName)),
    defaultName,
  }
}

export function wslStartDirectory(distribution: string): string {
  return `\\\\wsl.localhost\\${distribution}\\home`
}

export function readWslDistributions(): Promise<WslDistributions> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', LXSS_KEY, '/s'], { windowsHide: true, encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
      resolve(error ? { names: [], defaultName: null } : parseWslDistributions(stdout))
    })
  })
}
