import type { BuddyChatCommandDescriptionKey } from '@buddy-shared/conversation/buddyChatCommands'

import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalPromptContextItem } from '@buddy-shared/conversation/chatApi'
import type { BuddyComposerDirectory, BuddyComposerSource } from '@buddy-shared/conversation/composerResource'
import type { JSONContent } from '@tiptap/core'
import { BUDDY_CHAT_COMMANDS } from '@buddy-shared/conversation/buddyChatCommands'
import { buddyUserContentToText } from '@buddy-shared/conversation/buddyUserContent'
import { chatComposerDocumentToUserContent } from './chatComposerDocument'

export interface ChatPromptContextOption extends LocalPromptContextItem {
  description: string | null
  category?: 'artifact' | 'current' | 'history' | 'space' | 'external'
  commandId?: string
  resourceId?: string
  entryKind?: 'file' | 'directory'
  fileName?: string
  fileMetadata?: {
    mimeType: string
    sizeBytes: number
    nameSource?: 'file' | 'clipboard'
    createdAt?: string | null
    messageNumber?: number
  }
  label: string
  path: string | null
  source?: BuddyComposerSource
  skillScope?: 'directory' | 'space' | 'global'
}

export interface ChatComposerContextOptions {
  directory?: BuddyComposerDirectory
  files: ReadonlyArray<ChatPromptContextOption>
  skills: ReadonlyArray<ChatPromptContextOption>
  commands?: ReadonlyArray<ChatPromptContextOption>
}

export function createChatComposerSourceOptions(
  options: ReadonlyArray<ChatPromptContextOption>,
  query = '',
): ReadonlyArray<ChatPromptContextOption> {
  return filterChatComposerOptions(options, query)
    .filter(option => option.kind === 'file')
}

export interface ChatComposerTrigger {
  kind: 'slash' | 'skill' | 'mention'
  query: string
  rawQuery?: string
}

export interface ChatComposerSubmitPayload {
  content: string
  userContent?: BuddyUserContentV1
}

const TRIGGER_BOUNDARY_PATTERN = /[\s([{，。！？；：、"'`]$/u
const CHAT_COMPOSER_SUGGESTION_LIMIT = 8

export function createEmptyChatComposerContent(): JSONContent {
  return { content: [{ type: 'paragraph' }], type: 'doc' }
}

export function createChatComposerContentFromText(text: string): JSONContent {
  return {
    content: text.split('\n').map(line => ({
      content: line ? [{ text: line, type: 'text' }] : undefined,
      type: 'paragraph',
    })),
    type: 'doc',
  }
}

export function serializeChatComposerContent(content: JSONContent): ChatComposerSubmitPayload {
  const userContent = chatComposerDocumentToUserContent(content)
  return { content: buddyUserContentToText(userContent).trim(), userContent }
}

export function findChatComposerTrigger(textBeforeCursor: string): ChatComposerTrigger | null {
  const candidateSlashIndex = findTriggerStart(textBeforeCursor, '/')
  const slashIndex = candidateSlashIndex >= 0
    && textBeforeCursor.slice(0, candidateSlashIndex).trim().length === 0
    ? candidateSlashIndex
    : -1
  const skillIndex = findTriggerStart(textBeforeCursor, '$')
  const mentionIndex = findTriggerStart(textBeforeCursor, '@')
  const triggerIndex = Math.max(slashIndex, skillIndex, mentionIndex)
  if (triggerIndex < 0)
    return null

  const query = textBeforeCursor.slice(triggerIndex + 1)
  const trigger = textBeforeCursor[triggerIndex]
  if (trigger === '@' && query.startsWith('"') && !/[\r\n]/u.test(query)) {
    try {
      const decoded = JSON.parse(query.endsWith('"') && query.length > 1 ? query : `${query}"`) as string
      return { kind: 'mention', query: decoded, rawQuery: query }
    }
    catch {
      return null
    }
  }
  if (/\s/u.test(query))
    return null
  return {
    kind: trigger === '/' ? 'slash' : trigger === '$' ? 'skill' : 'mention',
    query,
  }
}

export function createChatComposerSuggestions(
  trigger: ChatComposerTrigger | null,
  options: ChatComposerContextOptions,
  translateCommand: (key: BuddyChatCommandDescriptionKey) => string = key => key,
) {
  if (!trigger)
    return []
  const candidates = trigger.kind === 'slash'
    ? [...BUDDY_CHAT_COMMANDS.map(command => ({
        description: translateCommand(command.descriptionKey),
        kind: 'slashCommand' as const,
        label: `/${command.name}`,
        path: null,
        value: `/${command.name}`,
      })), ...options.commands ?? []]
    : trigger.kind === 'skill' ? options.skills : createChatComposerSourceOptions(options.files)
  if (trigger.kind === 'slash')
    return candidates.filter(option => option.value.slice(1).startsWith(trigger.query)).slice(0, CHAT_COMPOSER_SUGGESTION_LIMIT).map(option => ({ option }))
  if (trigger.kind === 'mention')
    return candidates.map(option => ({ option }))
  return rankChatComposerOptions(candidates, trigger.query)
    .slice(0, CHAT_COMPOSER_SUGGESTION_LIMIT)
    .map(option => ({ option }))
}

export function shouldSubmitChatComposerKey(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'>,
) {
  return event.key === 'Enter'
    && !event.isComposing
    && !event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
}

function findTriggerStart(value: string, trigger: '/' | '$' | '@'): number {
  const index = value.lastIndexOf(trigger)
  if (index < 0 || (index > 0 && !TRIGGER_BOUNDARY_PATTERN.test(value[index - 1] ?? '')))
    return -1
  return index
}

function filterChatComposerOptions(
  options: ReadonlyArray<ChatPromptContextOption>,
  query: string,
): ReadonlyArray<ChatPromptContextOption> {
  const normalizedQuery = query.trim().toLowerCase()
  return options.filter(option => [option.label, option.fileName, option.value, option.path, option.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(normalizedQuery))
}

function rankChatComposerOptions(
  options: ReadonlyArray<ChatPromptContextOption>,
  query: string,
): ReadonlyArray<ChatPromptContextOption> {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery)
    return options
  const ranked: Array<{ index: number, option: ChatPromptContextOption, rank: number }> = []
  options.forEach((option, index) => {
    const rank = chatComposerOptionRank(option, normalizedQuery)
    if (rank !== null)
      ranked.push({ index, option, rank })
  })
  return ranked
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(entry => entry.option)
}

function chatComposerOptionRank(option: ChatPromptContextOption, query: string): number | null {
  const names = [option.label, option.fileName, option.value]
    .flatMap(name => name ? [name.toLowerCase()] : [])
  if (names.includes(query))
    return 0
  if (names.some(name => name.startsWith(query)))
    return 1
  if (names.some(name => name.includes(query)))
    return 2
  const detail = [option.path, option.description].filter(Boolean).join(' ').toLowerCase()
  return detail.includes(query) ? 3 : null
}
