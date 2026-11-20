import type { LocalRunEvent, RunEventPageInput } from './runApi'

export type ReadRunEventPage = (input: RunEventPageInput) => Promise<{ events: readonly LocalRunEvent[], nextSequence: number | null }>

export async function readRunEventWindow(read: ReadRunEventPage, input: RunEventPageInput, isCurrent: () => boolean = () => true): Promise<LocalRunEvent[]> {
  const events: LocalRunEvent[] = []
  let afterSequence = input.afterSequence
  while (afterSequence < input.throughSequence && isCurrent()) {
    const page = await read({ ...input, afterSequence })
    for (const event of page.events) {
      if (event.runId !== input.runId || event.sequence <= afterSequence || event.sequence > input.throughSequence)
        throw new Error('Invalid run event page')
      afterSequence = event.sequence
      events.push(event)
    }
    if (page.nextSequence === null)
      break
    if (!page.events.length || page.nextSequence !== afterSequence)
      throw new Error('Invalid run event cursor')
  }
  return events
}
