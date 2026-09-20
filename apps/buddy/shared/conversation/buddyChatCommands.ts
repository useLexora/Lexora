export type BuddyChatCommandName = 'compact' | 'review' | 'skills'
export type BuddyChatCommandDescriptionKey = `desktop.chat.command.${BuddyChatCommandName}`

export interface BuddyChatCommandDefinition {
  argumentHint: string | null
  descriptionKey: BuddyChatCommandDescriptionKey
  name: BuddyChatCommandName
}

export interface ParsedBuddyChatCommand {
  arguments: string
  name: BuddyChatCommandName
}

export const BUDDY_CHAT_COMMANDS: ReadonlyArray<BuddyChatCommandDefinition> = [
  {
    argumentHint: 'focus',
    descriptionKey: 'desktop.chat.command.compact',
    name: 'compact',
  },
  {
    argumentHint: 'focus',
    descriptionKey: 'desktop.chat.command.review',
    name: 'review',
  },
  {
    argumentHint: null,
    descriptionKey: 'desktop.chat.command.skills',
    name: 'skills',
  },
]

export const BUDDY_RUN_CHAT_COMMANDS: ReadonlyArray<BuddyChatCommandName> = ['compact']

const RETIRED_BUDDY_PROMPT_COMMANDS: readonly string[] = ['plan', 'status', 'skills']

const commandsByName = new Map(BUDDY_CHAT_COMMANDS.map(command => [command.name, command]))

export function parseBuddyChatCommand(value: string): ParsedBuddyChatCommand | null {
  const invocation = parseBuddyChatCommandInvocation(value)
  if (!invocation)
    return null
  const definition = commandsByName.get(invocation.name as BuddyChatCommandName)
  if (!definition)
    return null
  return { arguments: invocation.arguments, name: definition.name }
}

export function isBuddyRunChatCommand(name: string): boolean {
  return (BUDDY_RUN_CHAT_COMMANDS as ReadonlyArray<string>).includes(name)
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
