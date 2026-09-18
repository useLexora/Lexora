import type { BuddyToolPresentation } from '@buddy-shared/runs/runEventPresentation'
import type { ChatAgentToolNode } from './chatAgentTurn'
import type { BuddyI18nKey } from '@/i18n/buddyI18n'

export type ChatToolIcon = 'activity' | 'artifact' | 'authorization' | 'automation' | 'browser' | 'browser-act' | 'browser-open' | 'browser-snapshot' | 'connector' | 'create' | 'directory' | 'edit' | 'file' | 'image' | 'image-edit' | 'pet' | 'search' | 'skill' | 'terminal' | 'tool'
export type ChatToolCategory = 'read' | 'search' | 'command' | 'create' | 'edit' | 'web' | 'other'

interface ChatToolRegistration {
  category: ChatToolCategory
  icon: ChatToolIcon
  label: BuddyI18nKey
}

const cards = {
  'read': { category: 'read', icon: 'file', label: 'desktop.chat.processToolRead' },
  'search': { category: 'search', icon: 'search', label: 'desktop.chat.processToolSearch' },
  'terminal': { category: 'command', icon: 'terminal', label: 'desktop.chat.processToolCommand' },
  'diff': { category: 'edit', icon: 'edit', label: 'desktop.chat.processToolEdit' },
  'web': { category: 'web', icon: 'browser', label: 'desktop.chat.processToolWebFetch' },
  'browser': { category: 'web', icon: 'browser-act', label: 'desktop.chat.processToolBrowserAct' },
  'connector': { category: 'other', icon: 'connector', label: 'desktop.chat.processToolConnector' },
  'image': { category: 'other', icon: 'image', label: 'desktop.chat.processToolImage' },
  'pet': { category: 'other', icon: 'pet', label: 'desktop.chat.processToolPet' },
  'automation': { category: 'other', icon: 'automation', label: 'desktop.chat.processToolAutomation' },
  'system': { category: 'other', icon: 'tool', label: 'desktop.chat.processToolSystemAction' },
  'directory-authorization': { category: 'other', icon: 'authorization', label: 'desktop.chat.processToolDirectoryAuthorization' },
  'generic': { category: 'other', icon: 'tool', label: 'tool.use' },
} as const satisfies Record<BuddyToolPresentation['card'], ChatToolRegistration>

const skillRead = { ...cards.read, icon: 'skill', label: 'desktop.chat.processToolReadSkill' } as const satisfies ChatToolRegistration

const fileOperations = {
  created: { ...cards.diff, category: 'create', icon: 'create', label: 'desktop.chat.processToolCreate' },
  edited: cards.diff,
} as const satisfies Record<string, ChatToolRegistration>

const webOperations = {
  search: { ...cards.web, icon: 'search', label: 'desktop.chat.processToolWebSearch' },
  fetch: cards.web,
} as const satisfies Record<string, ChatToolRegistration>

const browserOperations = {
  open: { ...cards.browser, icon: 'browser-open', label: 'desktop.chat.processToolBrowserOpen' },
  snapshot: { ...cards.browser, icon: 'browser-snapshot', label: 'desktop.chat.processToolBrowserSnapshot' },
  act: cards.browser,
} as const satisfies Record<string, ChatToolRegistration>

const builtins: Readonly<Record<string, ChatToolRegistration>> = {
  bash: cards.terminal,
  lexora_host_shell: cards.terminal,
  lexora_authorize_directory: cards['directory-authorization'],
  powershell: cards.terminal,
  read: cards.read,
  edit: fileOperations.edited,
  write: fileOperations.created,
  grep: cards.search,
  find: { ...cards.search, label: 'desktop.chat.processToolFind' },
  ls: { ...cards.search, icon: 'directory', label: 'desktop.chat.processToolList' },
  lexora_web_search: webOperations.search,
  lexora_web_fetch: webOperations.fetch,
  lexora_browser_open: browserOperations.open,
  lexora_browser_snapshot: browserOperations.snapshot,
  lexora_browser_act: browserOperations.act,
  lexora_buddy_pet: cards.pet,
  lexora_buddy_automation: cards.automation,
  lexora_system_action: cards.system,
  lexora_image_generate: cards.image,
  lexora_image_chroma_key: { ...cards.image, icon: 'image-edit', label: 'desktop.chat.processToolImageTransform' },
  lexora_plugin_build: { category: 'other', icon: 'artifact', label: 'desktop.chat.processToolBuildPlugin' },
  lexora_output_present: { category: 'other', icon: 'artifact', label: 'desktop.chat.processToolPresent' },
  lexora_tool_search: { ...cards.search, label: 'desktop.chat.processToolDiscover' },
}

export function getChatToolRegistration(node: ChatAgentToolNode): ChatToolRegistration {
  const p = node.presentation
  if (p.card === 'read' && /(?:^|[/\\])[^/\\]+[/\\]SKILL\.md$/.test(p.path))
    return skillRead
  if (p.card === 'diff')
    return fileOperations[p.operation]
  if (p.card === 'web')
    return webOperations[p.operation]
  if (p.card === 'browser')
    return browserOperations[p.operation]
  return Object.hasOwn(builtins, node.toolName) ? builtins[node.toolName]! : cards[p.card]
}

export function isRegisteredChatTool(toolName: string): boolean {
  return Object.hasOwn(builtins, toolName)
}
