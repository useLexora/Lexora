import type { ContextPanelOperation } from '@buddy-shared/context-panel/contextPanel'
import type { LocalRun, LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { BuddyToolPresentation } from '@buddy-shared/runs/runEventPresentation'

import type { BuddyRunProgress } from '@buddy-shared/runs/runProgress'
import type { ToolFailureCode } from '@buddy-shared/runs/toolFailure'
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import type { ChatAgentCompactionNode } from './chatRunCompaction'
import type { ChatProjectionReducer } from './chatRunEventProjection'
import { contextPanelOperationSchema } from '@buddy-shared/context-panel/contextPanel'
import { approvalReviewPayloadSchema } from '@buddy-shared/permissions/approvalReviewPayload'
import { buddyRunProgressSchema } from '@buddy-shared/runs/runProgress'
import { isToolFailureCode } from '@buddy-shared/runs/toolFailure'
import { createChatRunCompactionReducer } from './chatRunCompaction'
import { readAssistantTextPhase, readNonnegativeInteger, readPayload, readString } from './chatRunEventProjection'
import { createChatRunTokenUsageReducer } from './chatRunTokenUsage'
import { approvalPresentation, normalizeProcessNarration, readToolPresentationUpdate, specificToolDescription } from './chatToolPresentation'

export type { ChatAgentCompactionNode } from './chatRunCompaction'

export interface ChatAgentReasoningNode {
  contentIndex: number
  id: string
  kind: 'reasoning'
  status: 'completed' | 'interrupted' | 'running'
  text: string
}

export interface ChatAgentNarrationNode {
  contentIndex?: number
  id: string
  kind: 'text'
  messageId: string
  phase?: 'commentary'
  text: string
}

export interface ChatAgentToolNode {
  approvalId?: string
  denialCode?: string
  errorCode?: ToolFailureCode
  description: string | null
  id: string
  isError: boolean
  kind: 'tool'
  presentation: BuddyToolPresentation
  status: 'awaiting_approval' | 'completed' | 'denied' | 'failed' | 'interrupted' | 'preparing' | 'running'
  toolCallId: string
  toolName: string
  toolLabel?: string
}

export interface ChatAgentPanelNode extends ContextPanelOperation {
  id: string
  kind: 'panel'
  status: 'completed'
}

export type ChatAgentTurnNode
  = | ChatAgentCompactionNode
    | ChatAgentNarrationNode
    | ChatAgentReasoningNode
    | ChatAgentToolNode
    | ChatAgentPanelNode

export interface ChatAgentTurn {
  branchId: string
  completedAt: string | null
  failureCode?: string | null
  failureMessage?: string | null
  finalMessageId: string | null
  nodes: ChatAgentTurnNode[]
  nodeStartedAt?: Readonly<Record<string, string>>
  messageStartedAt?: Readonly<Record<string, string>>
  processMessageIds: string[]
  progress: BuddyRunProgress | null
  reasoningLevel: string | null
  runId: string
  startedAt: string
  status: LocalRun['status']
  triggeringMessageId: string
  usage: LocalRunTokenUsage | null
}

export function projectChatAgentTurns(
  events: ReadonlyArray<LocalRunEvent>,
  runs: ReadonlyArray<LocalRun>,
): ChatAgentTurn[] {
  const eventsByRunId = new Map<string, LocalRunEvent[]>()
  for (const event of events) {
    const runEvents = eventsByRunId.get(event.runId) ?? []
    runEvents.push(event)
    eventsByRunId.set(event.runId, runEvents)
  }
  return runs
    .filter(run => run.purpose !== 'conversation.compaction')
    .map(run => projectChatAgentTurn(run, eventsByRunId.get(run.id) ?? []))
}

export function projectChatAgentTurn(
  run: LocalRun,
  events: ReadonlyArray<LocalRunEvent>,
): ChatAgentTurn {
  const reducer = createChatAgentTurnReducer(run)
  reducer.append(events)
  return reducer.project()
}

export function createChatAgentTurnReducer(
  run: LocalRun,
): ChatProjectionReducer<ChatAgentTurn> {
  const compactions = createChatRunCompactionReducer(run.id)
  const usage = createChatRunTokenUsageReducer(run.id)
  const reasoning = new Map<string, ChatAgentReasoningNode>()
  const tools = new Map<string, ChatAgentToolNode>()
  const approvalTools = new Map<string, string>()
  const text = new Map<string, ChatAgentNarrationNode>()
  const panels = new Map<string, ChatAgentPanelNode>()
  const nodeOrder = new Map<string, number>()
  const nodeStartedAt = new Map<string, string>()
  const messageStartedAt = new Map<string, string>()
  const processMessageIds = new Set<string>()
  let failureMessage: string | null = null
  let finalMessageId: string | null = null
  let progress: BuddyRunProgress | null = null
  let projection: ChatAgentTurn | null = null

  function append(events: ReadonlyArray<LocalRunEvent>) {
    usage.append(events)
    for (const event of events) {
      if (canAffectChatAgentTurn(event))
        projection = null
      apply(event)
    }
  }

  function apply(event: LocalRunEvent) {
    const payload = readPayload(event.payload)
    if (!payload)
      return
    if (event.type === 'desktop.panel.changed') {
      const operation = contextPanelOperationSchema.safeParse(payload)
      if (operation.success) {
        const id = `panel:${run.id}:${event.sequence}`
        rememberNode(id, event)
        panels.set(id, { ...operation.data, id, kind: 'panel', status: 'completed' })
      }
      return
    }
    if (event.type === 'message.started') {
      const messageId = readString(payload.messageId)
      if (messageId && messageId !== finalMessageId)
        finalMessageId = null
      if (messageId && !messageStartedAt.has(messageId))
        messageStartedAt.set(messageId, event.createdAt)
      return
    }
    if (event.type === 'run.failed') {
      failureMessage = readString(payload.errorMessage) || null
      return
    }
    if (event.type === 'run.progress') {
      const parsed = buddyRunProgressSchema.safeParse(payload)
      if (parsed.success)
        progress = parsed.data.phase === 'idle' ? null : parsed.data
      return
    }
    if (event.type.startsWith('context.compaction.')) {
      nodeStartedAt.set(`compaction:${run.id}:${event.sequence}`, event.createdAt)
      compactions.append([event])
      return
    }
    if (event.type.startsWith('message.block.')) {
      const messageId = readString(payload.messageId)
      const contentIndex = readNonnegativeInteger(payload.contentIndex)
      if (!messageId || contentIndex === null)
        return
      if (payload.kind === 'text') {
        const phase = readAssistantTextPhase(payload.phase)
        if (phase !== 'commentary')
          return
        const id = `process-text:${messageId}:${contentIndex}`
        const current = text.get(id)
        if (!current)
          rememberNode(id, event)
        const node = current ?? {
          contentIndex,
          id,
          kind: 'text' as const,
          messageId,
          phase: 'commentary' as const,
          text: '',
        }
        if (event.type === 'message.block.delta') {
          text.set(id, {
            ...node,
            text: node.text + readString(payload.delta),
          })
        }
        else if (event.type === 'message.block.completed') {
          text.set(id, {
            ...node,
            text: readString(payload.content),
          })
        }
        else {
          text.set(id, node)
        }
        return
      }
      if (payload.kind !== 'reasoning')
        return
      const id = `reasoning:${messageId}:${contentIndex}`
      const current = reasoning.get(id)
      if (!current)
        rememberNode(id, event)
      const node = current ?? {
        contentIndex,
        id,
        kind: 'reasoning' as const,
        status: 'running' as const,
        text: '',
      }
      if (event.type === 'message.block.delta') {
        reasoning.set(id, {
          ...node,
          text: node.text + readString(payload.delta),
        })
      }
      else if (event.type === 'message.block.completed') {
        reasoning.set(id, {
          ...node,
          status: 'completed',
          text: readString(payload.content),
        })
      }
      else {
        reasoning.set(id, node)
      }
      return
    }
    if (event.type === 'message.delta') {
      const phase = readAssistantTextPhase(payload.phase)
      const messageId = readString(payload.messageId)
      const contentIndex = readNonnegativeInteger(payload.contentIndex)
      if (phase !== 'commentary' || !messageId || contentIndex === null)
        return
      const id = `process-text:${messageId}:${contentIndex}`
      const current = text.get(id)
      if (!current)
        rememberNode(id, event)
      const node = current ?? {
        contentIndex,
        id,
        kind: 'text' as const,
        messageId,
        phase: 'commentary' as const,
        text: '',
      }
      text.set(id, {
        ...node,
        text: node.text + readString(payload.delta),
      })
      return
    }
    if (event.type === 'message.completed') {
      const messageId = readString(payload.messageId)
      const content = readPayload(payload.content)
      if (!messageId)
        return
      const phase = readAssistantTextPhase(payload.phase)
      const isCommentary = phase === 'commentary'
        || (!phase && payload.stopReason === 'tool_use')
      finalMessageId = null
      if (isCommentary) {
        processMessageIds.add(messageId)
        const value = readString(content?.text)
        const normalized = normalizeProcessNarration(value)
        const duplicatesReasoning = normalized && [...reasoning.values()].some(node => (
          normalizeProcessNarration(node.text) === normalized
        ))
        if (normalized && !duplicatesReasoning) {
          const existing = [...text.values()].filter(node => node.messageId === messageId)
          if (existing.length <= 1) {
            const current = existing[0]
            const id = current?.id ?? `process-text:${messageId}:message`
            if (!current)
              rememberNode(id, event)
            text.set(id, {
              ...current,
              id,
              kind: 'text',
              messageId,
              phase: 'commentary',
              text: value,
            })
          }
        }
      }
      else if (phase === 'final_answer') {
        processMessageIds.delete(messageId)
        finalMessageId = messageId
      }
      else {
        processMessageIds.delete(messageId)
        finalMessageId = messageId
      }
      return
    }
    if (event.type === 'approval.requested') {
      const approvalId = readString(payload.id)
      const toolCallId = readString(payload.toolCallId)
      const current = tools.get(toolCallId)
      const review = approvalReviewPayloadSchema.safeParse(payload.review)
      const structuredApprovalPresentation = review.success
        && review.data.card === 'system-action'
        ? approvalPresentation(review.data)
        : null
      const base = current
        ? structuredApprovalPresentation
          ? {
              ...current,
              description: null,
              presentation: structuredApprovalPresentation,
            }
          : current
        : review.success
          ? {
              id: `tool:${toolCallId}`,
              isError: false,
              kind: 'tool' as const,
              presentation: approvalPresentation(review.data),
              status: 'preparing' as const,
              toolCallId,
              toolName: review.data.toolName,
              description: review.data.card === 'system-action'
                ? null
                : readString(payload.summary) || null,
            }
          : null
      if (approvalId && toolCallId)
        approvalTools.set(approvalId, toolCallId)
      if (approvalId && toolCallId && base) {
        if (!current)
          rememberNode(base.id, event)
        tools.set(toolCallId, {
          ...base,
          approvalId,
          status: 'awaiting_approval',
        })
      }
      return
    }
    if (event.type === 'approval.resolved') {
      const approvalId = readString(payload.id)
      const toolCallId = approvalTools.get(approvalId)
      const current = toolCallId ? tools.get(toolCallId) : undefined
      if (current?.status === 'awaiting_approval') {
        const status = payload.status === 'approved'
          ? 'preparing'
          : payload.status === 'denied'
            ? 'denied'
            : 'interrupted'
        tools.set(current.toolCallId, {
          ...current,
          isError: payload.status !== 'approved',
          status,
        })
      }
      return
    }
    if (event.type === 'tool.denied' || event.type === 'tool.failed') {
      const toolCallId = readString(payload.toolCallId)
      const current = toolCallId ? tools.get(toolCallId) : undefined
      const code = readString(event.type === 'tool.failed' ? payload.errorCode : payload.denialCode)
      const errorCode = isToolFailureCode(code) ? code : undefined
      if (current) {
        tools.set(current.toolCallId, {
          ...current,
          ...(errorCode ? { errorCode } : code ? { denialCode: code } : {}),
          isError: true,
          status: errorCode || event.type === 'tool.failed' ? 'failed' : 'denied',
        })
      }
      return
    }
    if (
      event.type === 'tool.preparing'
      || event.type === 'tool.started'
      || event.type === 'tool.updated'
      || event.type === 'tool.completed'
    ) {
      const toolCallId = readString(payload.toolCallId)
      const toolName = readString(payload.toolName)
      if (!toolCallId || !toolName)
        return
      const current = tools.get(toolCallId)
      const presentation = readToolPresentationUpdate(payload, current?.presentation)
      if (!presentation)
        return
      const toolLabel = readString(payload.toolLabel) || current?.toolLabel
      const isError = event.type === 'tool.completed' && payload.isError === true
      const narration = current ? null : [...text.values()].at(-1)
      const toolNarration = narration?.phase === 'commentary' ? null : narration
      const isStructuredTool = presentation.card === 'automation'
        || presentation.card === 'directory-authorization'
        || presentation.card === 'system'
      const description = isStructuredTool
        ? null
        : current?.description
          ?? toolNarration?.text
          ?? specificToolDescription(
            'description' in presentation ? presentation.description : null,
          )
          ?? null
      if (!isStructuredTool && toolNarration && description === toolNarration.text)
        text.delete(toolNarration.id)
      if (!current)
        rememberNode(`tool:${toolCallId}`, event)
      tools.set(toolCallId, {
        ...(current?.approvalId ? { approvalId: current.approvalId } : {}),
        ...(current?.denialCode ? { denialCode: current.denialCode } : {}),
        ...(current?.errorCode ? { errorCode: current.errorCode } : {}),
        description,
        ...(toolLabel ? { toolLabel } : {}),
        id: `tool:${toolCallId}`,
        isError: isError || Boolean(current?.denialCode || current?.errorCode),
        kind: 'tool',
        presentation,
        status: current?.status === 'denied' || current?.status === 'interrupted'
          ? current.status
          : current?.errorCode
            ? 'failed'
            : event.type === 'tool.completed'
              ? isError ? 'failed' : 'completed'
              : current?.status === 'awaiting_approval'
                ? 'awaiting_approval'
                : event.type === 'tool.preparing'
                  ? 'preparing'
                  : 'running',
        toolCallId,
        toolName,
      })
    }
  }

  function rememberNode(id: string, event: LocalRunEvent) {
    nodeOrder.set(id, event.sequence)
    if (!nodeStartedAt.has(id))
      nodeStartedAt.set(id, event.createdAt)
  }

  function readNodeOrder(node: ChatAgentTurnNode): number {
    return nodeOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER
  }

  function project(): ChatAgentTurn {
    if (projection)
      return projection
    const terminal = run.status !== 'queued' && run.status !== 'running'
    const reasoningNodes = [...reasoning.values()].filter(node => node.text.trim())
    const narrationNodes = [...text.values()].filter(node => node.text.trim())
    const awaitingApproval = [...tools.values()]
      .filter(node => node.status === 'awaiting_approval')
      .sort((left, right) => readNodeOrder(right) - readNodeOrder(left))[0]
    const compactionNodes = compactions.project().map(({ node, sequence }) => {
      nodeOrder.set(node.id, sequence)
      return node
    })
    const nodes = [...reasoningNodes, ...narrationNodes, ...tools.values(), ...compactionNodes, ...panels.values()]
      .sort((left, right) => readNodeOrder(left) - readNodeOrder(right))
      .map((node) => {
        if (
          node.kind === 'text'
          || !terminal
          || (node.status !== 'preparing' && node.status !== 'running')
        ) {
          return node
        }
        return { ...node, status: 'interrupted' as const }
      })
    projection = {
      branchId: run.branchId,
      completedAt: run.completedAt,
      ...(run.status === 'failed'
        ? { failureCode: run.errorCode, failureMessage }
        : {}),
      finalMessageId,
      nodes,
      ...(messageStartedAt.size ? { messageStartedAt: Object.fromEntries(messageStartedAt) } : {}),
      nodeStartedAt: Object.fromEntries(nodes.map(node => [node.id, nodeStartedAt.get(node.id) ?? run.startedAt])),
      processMessageIds: [...processMessageIds],
      progress: terminal
        ? null
        : awaitingApproval
          ? { phase: 'awaiting_approval', toolName: awaitingApproval.toolName }
          : progress,
      reasoningLevel: run.reasoningLevel,
      runId: run.id,
      startedAt: run.startedAt,
      status: run.status,
      triggeringMessageId: run.triggeringMessageId,
      usage: usage.project(),
    }
    return projection
  }

  return { append, project }
}

function canAffectChatAgentTurn(event: LocalRunEvent): boolean {
  const payload = readPayload(event.payload)
  if (!payload)
    return false
  if (event.type === 'message.delta')
    return readAssistantTextPhase(payload.phase) === 'commentary'
  if (event.type.startsWith('message.block.')) {
    return payload.kind === 'reasoning'
      || (payload.kind === 'text' && readAssistantTextPhase(payload.phase) === 'commentary')
  }
  return event.type === 'run.failed'
    || event.type === 'desktop.panel.changed'
    || event.type === 'usage.recorded'
    || event.type === 'run.progress'
    || event.type.startsWith('context.compaction.')
    || event.type === 'message.started'
    || event.type === 'message.completed'
    || event.type.startsWith('approval.')
    || event.type.startsWith('tool.')
}
