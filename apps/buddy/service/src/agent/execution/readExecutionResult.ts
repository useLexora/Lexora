import type { RunEventReader } from '../../events/RunEventPorts'
import { z } from 'zod'

const completionSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.object({ text: z.string() })]),
  phase: z.string().optional(),
  stopReason: z.string().optional(),
})

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
