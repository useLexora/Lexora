import {
  AGENT_WEB_SEARCH_PROVIDER_VALUES,
  AgentWebSearchProviderSchema,
} from '@haohaoxue/lexora-contracts'
import { z } from 'zod'

const DomainSchema = z.string().trim().min(1).describe('Domain name without protocol, for example openai.com.')

export const WebSearchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(200).describe('Precise search query.'),
  providers: z.array(AgentWebSearchProviderSchema).min(1).max(AGENT_WEB_SEARCH_PROVIDER_VALUES.length).optional().describe('Optional subset of enabled search providers to use for this query.'),
  maxResults: z.number().int().min(1).max(10).optional().describe('Maximum number of search results to return.'),
  allowedDomains: z.array(DomainSchema).max(20).optional().describe('Only return results from these domains when provided.'),
  blockedDomains: z.array(DomainSchema).max(20).optional().describe('Exclude results from these domains.'),
}).strict()
