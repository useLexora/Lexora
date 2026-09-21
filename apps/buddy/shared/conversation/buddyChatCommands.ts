export type BuddyChatCommandName = 'compact' | 'review' | 'skills' | 'status'
export type BuddyChatCommandDescriptionKey = `desktop.chat.command.${BuddyChatCommandName}`

export type BuddyChatCommandDefinition = {
  argumentHint: string | null
  descriptionKey: BuddyChatCommandDescriptionKey
  name: BuddyChatCommandName
} & (
  | { kind: 'prompt' }
  | { kind: 'action', action: 'run' | 'view' | 'input' }
)

export interface ParsedBuddyChatCommand {
  arguments: string
  name: BuddyChatCommandName
}

const commandsByName: Readonly<Record<BuddyChatCommandName, BuddyChatCommandDefinition>> = {
  compact: {
    kind: 'action',
    action: 'run',
    argumentHint: 'focus',
    descriptionKey: 'desktop.chat.command.compact',
    name: 'compact',
  },
  review: {
    kind: 'prompt',
    argumentHint: 'focus',
    descriptionKey: 'desktop.chat.command.review',
    name: 'review',
  },
  skills: {
    kind: 'action',
    action: 'input',
    argumentHint: null,
    descriptionKey: 'desktop.chat.command.skills',
    name: 'skills',
  },
  status: {
    kind: 'action',
    action: 'view',
    argumentHint: null,
    descriptionKey: 'desktop.chat.command.status',
    name: 'status',
  },
}

export const BUDDY_CHAT_COMMANDS: ReadonlyArray<BuddyChatCommandDefinition> = Object.values(commandsByName)

const RETIRED_BUDDY_PROMPT_COMMANDS: readonly string[] = ['plan', 'status', 'skills']

export function getBuddyChatCommandDefinition(name: BuddyChatCommandName): BuddyChatCommandDefinition {
  return commandsByName[name]
}

export function parseBuddyChatCommand(value: string): ParsedBuddyChatCommand | null {
  const invocation = parseBuddyChatCommandInvocation(value)
  if (!invocation)
    return null
  const definition = BUDDY_CHAT_COMMANDS.find(command => command.name === invocation.name)
  if (!definition)
    return null
  return { arguments: invocation.arguments, name: definition.name }
}

export function isBuddyRunChatCommand(name: string): boolean {
  const definition = BUDDY_CHAT_COMMANDS.find(command => command.name === name)
  return definition?.kind === 'action' && definition.action === 'run'
}

export function isBuddyReviewCommand(value: string): boolean {
  const invocation = parseBuddyChatCommandInvocation(value)
  return invocation?.name === 'review'
}

export function isRetiredBuddyPromptCommand(value: string): boolean {
  const invocation = parseBuddyChatCommandInvocation(value)
  return Boolean(invocation && RETIRED_BUDDY_PROMPT_COMMANDS.includes(invocation.name))
}

function parseBuddyChatCommandInvocation(value: string): { arguments: string, name: string } | null {
  const normalized = value.trimStart()
  const separatorIndex = normalized.search(/\s/u)
  const invocation = separatorIndex < 0 ? normalized : normalized.slice(0, separatorIndex)
  const match = /^\/([a-z][a-z-]*)$/i.exec(invocation)
  if (!match)
    return null
  return {
    arguments: separatorIndex < 0 ? '' : normalized.slice(separatorIndex).trim(),
    name: match[1]!.toLowerCase(),
  }
}
