import type { Context, TranscriptContext } from '@earendil-works/pi-ai'
import type { ToolInfo } from '@earendil-works/pi-coding-agent'
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai'
import { buildBuddySystemSections } from './buddySystemSections'
import { withRequestSystemSection } from './withRequestSystemSection'

export function buildBuddyRequestContext(context: Context, definitions: readonly ToolInfo[]): TranscriptContext {
  const transcript = normalizeContext(context)
  const active = new Set(getCurrentTools(transcript.messages).map(tool => tool.name))
  const sections = buildBuddySystemSections(transcript.messages, definitions.filter(tool => active.has(tool.name)))
  return Object.entries(sections).reduce((context, [name, content]) => withRequestSystemSection(context, name, content), transcript)
}
