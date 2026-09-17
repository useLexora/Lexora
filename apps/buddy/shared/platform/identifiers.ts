export const OPERATING_SYSTEM = {
  Linux: 'linux',
  Windows: 'win32',
  MacOS: 'darwin',
} as const

export type OperatingSystem = typeof OPERATING_SYSTEM[keyof typeof OPERATING_SYSTEM]

export const CPU_ARCHITECTURE = {
  X64: 'x64',
  ARM64: 'arm64',
} as const

export type CpuArchitecture = typeof CPU_ARCHITECTURE[keyof typeof CPU_ARCHITECTURE]

export const SHELL_SANDBOX_BACKEND = {
  Linux: 'linux-srt',
  MacOS: 'macos-srt',
  Windows: 'windows-lpac',
} as const

export type ShellSandboxBackend = typeof SHELL_SANDBOX_BACKEND[keyof typeof SHELL_SANDBOX_BACKEND]

export interface PlatformTarget {
  platform: OperatingSystem
  architecture: CpuArchitecture
}

export function isLinux(platform: string): platform is typeof OPERATING_SYSTEM.Linux {
  return platform === OPERATING_SYSTEM.Linux
}

export function isWindows(platform: string): platform is typeof OPERATING_SYSTEM.Windows {
  return platform === OPERATING_SYSTEM.Windows
}

export function isMacOS(platform: string): platform is typeof OPERATING_SYSTEM.MacOS {
  return platform === OPERATING_SYSTEM.MacOS
}
