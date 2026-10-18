import type { RunEventReader } from '../../events/RunEventPorts'
import { z } from 'zod'

const completionSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.object({ text: z.string() })]),
  phase: z.string().optional(),
  stopReason: z.string().optional(),
})

export function previewExecutionResult(text: string, runId: string): string {
  const limit = 8000
  if (text.length <= limit)
    return text
  const notice = `[Result preview truncated. Full task output is retained. Use lexora_agents with operation="result", runId="${runId}" and follow nextOffset to read every page before relying on omitted details.]\n\n`
  const end = limit - notice.length
  const prefix = text.slice(0, end).replace(/[\uD800-\uDBFF]$/, '')
  return notice + prefix
}

export async function readExecutionResult(events: Pick<RunEventReader, 'read'>, runId: string): Promise<string> {
  const replies = new Set<string>()
  for (const event of await events.read(runId)) {
    if (event.type !== 'message.completed')
      continue
    const parsed = completionSchema.safeParse(event.payload)
    if (!parsed.success || parsed.data.phase === 'commentary'
      || (parsed.data.stopReason && parsed.data.stopReason !== 'completed')) {
      continue
    }
    const text = typeof parsed.data.content === 'string' ? parsed.data.content : parsed.data.content.text
    if (text.trim()) {
      replies.delete(text)
      replies.add(text)
    }
  }
  const results = [...replies]
  const latest = results.pop() ?? ''
  return results.length
    ? `${latest}\n\nEarlier task results, in chronological order. Later corrections supersede earlier conclusions:\n\n${results.join('\n\n---\n\n')}`
    : latest
}
