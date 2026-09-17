export type DesktopLaunchIntent = 'background' | 'foreground'

export function resolveDesktopLaunchIntent(argv: readonly string[], openedAtLogin = false): DesktopLaunchIntent {
  return openedAtLogin || argv.includes('--background') ? 'background' : 'foreground'
}
