import { resolveBuddyPlatform } from '../../../../shared/platform'

const PI_FILE_TOOL_NAMES = [
  'edit',
  'find',
  'grep',
  'ls',
  'read',
  'write',
] as const

export const PI_SHELL_TOOL_NAMES = ['bash', 'powershell'] as const

export const PI_BUILTIN_TOOL_NAMES = [
  ...PI_FILE_TOOL_NAMES,
  ...PI_SHELL_TOOL_NAMES,
] as const

export const PI_BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(PI_BUILTIN_TOOL_NAMES)

export type PiShellToolName = typeof PI_SHELL_TOOL_NAMES[number]

export function getPiShellToolName(platform: NodeJS.Platform): PiShellToolName {
  return resolveBuddyPlatform(platform).shell
}

export function getActivePiBuiltinToolNames(
  platform: NodeJS.Platform,
): readonly (typeof PI_BUILTIN_TOOL_NAMES[number])[] {
  return [...PI_FILE_TOOL_NAMES, getPiShellToolName(platform)]
}

export function isShellToolName(toolName: string): boolean {
  return toolName === 'lexora_shell' || isPiShellToolName(toolName)
}

export function isPiShellToolName(toolName: string): toolName is PiShellToolName {
  return (PI_SHELL_TOOL_NAMES as readonly string[]).includes(toolName)
}
