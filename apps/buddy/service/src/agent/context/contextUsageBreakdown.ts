import type {
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
} from '@earendil-works/pi-ai'
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai'

export interface BuddyContextUsageBreakdown {
  mcpTokens: number
  messageTokens: number
  skillTokens: number
  systemPromptTokens: number
  toolTokens: number
}

export interface BuddyEstimatedContextUsage extends BuddyContextUsageBreakdown {
  totalTokens: number
}

const CHARS_PER_TOKEN = 4
const ESTIMATED_IMAGE_CHARS = 4_800
const SKILL_CATALOG_START = 'The following skills provide specialized instructions for specific tasks.'
const SKILL_CATALOG_END = '</available_skills>'
const SELECTED_SKILL_PATTERN = /<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g

export function createContextUsageBreakdown(
  context: Context,
  totalTokens: number,
): BuddyContextUsageBreakdown {
  const total = Math.max(0, Math.floor(totalTokens))
  const estimates = estimateFixedContextSources(context)
  const attributedTotal = Object.values(estimates).reduce((sum, value) => sum + value, 0)
  if (attributedTotal <= total) {
    return {
      ...estimates,
      messageTokens: total - attributedTotal,
    }
  }

  const scaled = scaleTokenEstimates(estimates, total)
  return { ...scaled, messageTokens: 0 }
}

export function createEstimatedContextUsage(context: Context): BuddyEstimatedContextUsage {
  const fixed = estimateFixedContextSources(context)
  const selectedSkillTokens = estimateSelectedSkillTokens(context.messages)
  const messageTokens = Math.max(0, estimateMessages(context.messages) - selectedSkillTokens)
  const totalTokens = Object.values(fixed).reduce((sum, value) => sum + value, messageTokens)
  return {
    ...fixed,
    messageTokens,
    totalTokens,
  }
}

function estimateFixedContextSources(
  context: Context,
): Omit<BuddyContextUsageBreakdown, 'messageTokens'> {
  const { messages } = normalizeContext(context)
  const systemPrompt = getCurrentSystemPrompt(messages)
  const tools = getCurrentTools(messages)
  const skillCatalog = readSkillCatalog(systemPrompt)
  return {
    mcpTokens: estimateTools(tools.filter(tool => tool.name.startsWith('mcp__'))),
    skillTokens: estimateTextTokens(skillCatalog)
      + estimateSelectedSkillTokens(context.messages),
    systemPromptTokens: estimateTextTokens(systemPrompt.replace(skillCatalog, '')),
    toolTokens: estimateTools(tools.filter(tool => !tool.name.startsWith('mcp__'))),
  }
}

function readSkillCatalog(systemPrompt: string): string {
  const start = systemPrompt.indexOf(SKILL_CATALOG_START)
  if (start < 0)
    return ''
  const end = systemPrompt.indexOf(SKILL_CATALOG_END, start)
  if (end < 0)
    return ''
  const leadingBreak = systemPrompt.lastIndexOf('\n\n', start)
  return systemPrompt.slice(leadingBreak >= 0 ? leadingBreak : start, end + SKILL_CATALOG_END.length)
}

function estimateSelectedSkillTokens(messages: Message[]): number {
  let tokens = 0
  for (const message of messages) {
    if (message.role !== 'user')
      continue
    const text = typeof message.content === 'string'
      ? message.content
      : message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
    for (const match of text.matchAll(SELECTED_SKILL_PATTERN))
      tokens += estimateTextTokens(match[0])
  }
  return tokens
}

function estimateMessages(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

function estimateMessageTokens(message: Message): number {
  if (message.role === 'system')
    return 0
  if (message.role === 'user' || message.role === 'toolResult')
    return estimateTextAndImageContentTokens(message.content)

  let characters = 0
  for (const block of message.content) {
    if (block.type === 'text')
      characters += block.text.length
    else if (block.type === 'thinking')
      characters += block.thinking.length
    else
      characters += block.name.length + safeJsonStringify(block.arguments).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN)
}

function estimateTextAndImageContentTokens(
  content: string | Array<ImageContent | TextContent>,
): number {
  if (typeof content === 'string')
    return estimateTextTokens(content)
  const characters = content.reduce((sum, block) => (
    sum + (block.type === 'text' ? block.text?.length ?? 0 : ESTIMATED_IMAGE_CHARS)
  ), 0)
  return Math.ceil(characters / CHARS_PER_TOKEN)
}

function estimateTools(tools: Tool[] | undefined): number {
  if (!tools?.length)
    return 0
  return estimateTextTokens(safeJsonStringify(tools))
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  }
  catch {
    return ''
  }
}

function scaleTokenEstimates(
  estimates: Omit<BuddyContextUsageBreakdown, 'messageTokens'>,
  totalTokens: number,
): Omit<BuddyContextUsageBreakdown, 'messageTokens'> {
  const entries = Object.entries(estimates) as Array<[
    keyof typeof estimates,
    number,
  ]>
  const estimatedTotal = entries.reduce((sum, [, value]) => sum + value, 0)
  if (estimatedTotal === 0)
    return estimates

  const scaled = entries.map(([kind, value]) => {
    const exact = value / estimatedTotal * totalTokens
    return { exact, kind, tokens: Math.floor(exact) }
  })
  let remainder = totalTokens - scaled.reduce((sum, item) => sum + item.tokens, 0)
  scaled.sort((left, right) => (right.exact - right.tokens) - (left.exact - left.tokens))
  for (const item of scaled) {
    if (remainder === 0)
      break
    item.tokens += 1
    remainder -= 1
  }

  return Object.fromEntries(scaled.map(item => [item.kind, item.tokens])) as Omit<
    BuddyContextUsageBreakdown,
    'messageTokens'
  >
}
