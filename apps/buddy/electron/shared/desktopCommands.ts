import type { BuddyPlatformId } from '../../shared/platform'

export const DESKTOP_COMMAND_IDS = [
  'app.about',
  'app.checkUpdates',
  'app.quit',
  'window.close',
  'window.toggleDeveloperTools',
  'help.openDocumentation',
  'help.openLogsDirectory',
  'help.feedback',
] as const

export type DesktopCommandId = typeof DESKTOP_COMMAND_IDS[number]
export type DesktopCommandExecution = 'main' | 'renderer'
export type DesktopCommandMenu = 'application' | 'window' | 'help'
export type DesktopCommandScope = 'application' | 'window'
export type DesktopPlatform = BuddyPlatformId

export interface DesktopCommandDefinition {
  execution: DesktopCommandExecution
  id: DesktopCommandId
  menu: DesktopCommandMenu
  showInMenu: boolean
  scope: DesktopCommandScope
  section: number
  keybinding?: string
  macosKeybinding?: string
  alternateKeybindings?: readonly string[]
}

export const DESKTOP_COMMAND_REGISTRY = [
  command('app.about', 'application', 0, 'renderer', 'application'),
  command('app.checkUpdates', 'application', 0, 'renderer', 'application'),
  command('app.quit', 'application', 1, 'main', 'application', {
    keybinding: 'Alt+F4',
    macosKeybinding: 'Mod+Q',
  }),
  command('window.close', 'window', 0, 'main', 'window', {
    keybinding: 'Mod+Shift+W',
  }),
  command('window.toggleDeveloperTools', 'window', 1, 'main', 'window', {
    keybinding: 'Mod+Shift+I',
    alternateKeybindings: ['F12'],
  }, false),
  command('help.openDocumentation', 'help', 0, 'main', 'application'),
  command('help.openLogsDirectory', 'help', 0, 'main', 'application'),
  command('help.feedback', 'help', 1, 'renderer', 'application'),
] as const satisfies ReadonlyArray<DesktopCommandDefinition>

export function getDesktopCommand(commandId: DesktopCommandId): DesktopCommandDefinition {
  const command = DESKTOP_COMMAND_REGISTRY.find(candidate => candidate.id === commandId)
  if (!command)
    throw new Error(`Unknown Desktop command: ${commandId}`)
  return command
}

export function getDesktopMenuCommands(menu: DesktopCommandMenu): ReadonlyArray<DesktopCommandDefinition> {
  return DESKTOP_COMMAND_REGISTRY.filter(command => command.menu === menu && command.showInMenu)
}

export function isDesktopCommandId(value: unknown): value is DesktopCommandId {
  if (typeof value !== 'string')
    return false
  return (DESKTOP_COMMAND_IDS as ReadonlyArray<string>).includes(value)
}

function command(
  id: DesktopCommandId,
  menu: DesktopCommandMenu,
  section: number,
  execution: DesktopCommandExecution,
  scope: DesktopCommandScope,
  shortcuts: Pick<DesktopCommandDefinition, 'keybinding' | 'macosKeybinding' | 'alternateKeybindings'> = {},
  showInMenu = true,
): DesktopCommandDefinition {
  return { execution, id, menu, scope, section, ...shortcuts, showInMenu }
}
