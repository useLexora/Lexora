import type { TranscriptContext } from '@earendil-works/pi-ai'
import { getCurrentSystemMessage, normalizeContext } from '@earendil-works/pi-ai'

export function withRequestSystemSection(context: TranscriptContext, name: string, content: string): TranscriptContext {
  const value = content ? `<${name}>\n${content}\n</${name}>` : null
  if ((getCurrentSystemMessage(context.messages)?.sections?.[name] ?? null) === value)
    return context
  return normalizeContext({
    messages: [...context.messages, {
      role: 'system',
      content: '',
      sections: { [name]: value },
      timestamp: context.messages.at(-1)?.timestamp ?? 0,
    }],
  })
}
