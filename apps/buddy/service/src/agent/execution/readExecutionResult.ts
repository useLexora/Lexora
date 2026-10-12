import type { RunEventReader } from '../../events/RunEventPorts'
import { z } from 'zod'

const completionSchema = z.object({ role: z.literal('assistant'), content: z.union([z.string(), z.object({ text: z.string() })]) })

export async function readExecutionResult(events: Pick<RunEventReader, 'read'>, runId: string): Promise<string> {
  const completed = (await events.read(runId)).filter(event => event.type === 'message.completed').at(-1)
  const parsed = completionSchema.safeParse(completed?.payload)
  return parsed.success ? typeof parsed.data.content === 'string' ? parsed.data.content : parsed.data.content.text : ''
}
