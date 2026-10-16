import { AgentTimeZoneSchema } from '@haohaoxue/lexora-contracts'
import { z } from 'zod'

export const GetCurrentTimeToolInputSchema = z.object({
  timeZone: AgentTimeZoneSchema.optional().describe('Optional IANA time zone, for example Asia/Shanghai or America/New_York.'),
}).strict()
