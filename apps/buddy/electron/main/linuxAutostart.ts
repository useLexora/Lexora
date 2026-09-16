import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import buddyPackage from '../../package.json'

interface LinuxAutostartOptions {
  configDirectory: string
  enabled: boolean
  executablePath: string
}

export function resolveLinuxConfigDirectory(
  homeDirectory: string,
  xdgConfigHome: string | undefined,
): string {
  return xdgConfigHome && isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : join(homeDirectory, '.config')
}

export async function syncLinuxAutostart(options: LinuxAutostartOptions): Promise<void> {
  const autostartDirectory = join(options.configDirectory, 'autostart')
  const entryPath = join(autostartDirectory, `${buddyPackage.desktopName}.desktop`)
  if (!options.enabled) {
    await rm(entryPath, { force: true })
    return
  }

  const executablePath = options.executablePath
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('`', '\\`')
    .replaceAll('$', '\\$')
    .replaceAll('%', '%%')
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${buddyPackage.productName}`,
    `TryExec=${executablePath}`,
    `Exec="${executablePath}" --background`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')

  await mkdir(autostartDirectory, { mode: 0o700, recursive: true })
  await writeFile(entryPath, entry, { encoding: 'utf8', mode: 0o600 })
  await chmod(entryPath, 0o600)
}
