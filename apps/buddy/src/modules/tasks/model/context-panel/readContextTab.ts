import type { ContextPanelScope, TaskContextTab } from './taskContextPanel'
import { artifactSchema } from '@buddy-shared/artifacts/artifactApi'
import { changeSetSummarySchema } from '@buddy-shared/changes/changeApi'
import { contextPanelSourceSchema } from '@buddy-shared/context-panel/contextPanel'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { z } from 'zod'

const identity = z.string().min(1).max(256)
const scopeSchema = z.union([z.literal('independent'), z.literal('workspace'), z.templateLiteral(['task:', z.string().min(1)]), z.templateLiteral(['draft:', z.string().min(1)])])
const selectionSchema = z.tuple([scopeSchema, identity])
const base = z.object({ id: identity, scope: scopeSchema, source: contextPanelSourceSchema.optional() })
const tabSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('browser'), conversationId: identity.nullable(), browserKey: identity.optional() }),
  base.extend({ kind: z.literal('files'), target: spaceFileTargetSchema, rootName: z.string() }),
  base.extend({ kind: z.literal('artifact'), artifact: artifactSchema, label: z.string(), viewMode: z.enum(['preview', 'source']) }),
  base.extend({ kind: z.literal('changes'), branchId: identity.nullable(), revision: z.string(), changeSet: changeSetSummarySchema.nullable(), conversationId: identity }),
  base.extend({ kind: z.literal('view'), viewId: identity, label: z.string() }),
])

export function readContextTab(value: unknown): TaskContextTab | null {
  const parsed = tabSchema.safeParse(value)
  if (!parsed.success || (parsed.data.kind === 'view' && parsed.data.viewId !== parsed.data.id))
    return null
  return parsed.data
}

export function readContextSelection(value: unknown): readonly [ContextPanelScope, string] | null {
  const parsed = selectionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
