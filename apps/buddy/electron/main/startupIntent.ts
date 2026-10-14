export type DesktopLaunchIntent = 'background' | 'foreground'

export function resolveDesktopLaunchIntent(argv: readonly string[], openedAtLogin = false): DesktopLaunchIntent {
  return openedAtLogin || argv.includes('--background') ? 'background' : 'foreground'
}

export const INSTALLER_EXIT_ARGUMENT = '--quit-for-install'

export function isInstallerExitRequest(argv: readonly string[], data: unknown, executable: string): boolean {
  return argv.includes(INSTALLER_EXIT_ARGUMENT)
    && typeof data === 'object' && data !== null && 'executablePath' in data
    && typeof data.executablePath === 'string'
    && data.executablePath.toLowerCase() === executable.toLowerCase()
}
