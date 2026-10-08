import type { LocalConversationTree, LocalConversationTreeNode } from '../../../shared/conversation/conversationTree'
import type { LocalRunOutput } from '../../../shared/runs/runApi'
import type { LocalRunTokenUsage } from '../../../shared/usage/runTokenUsage'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import type { ConversationBranchRecord, MessageRecord } from '../storage/conversationHistoryRepository'
import type { RunRecord } from '../storage/runRecord'
import { buddyUserContentToText, readBuddyUserMessageContent } from '../../../shared/conversation/buddyUserContent'
import { CONVERSATION_QUOTE_PREVIEW_LENGTH } from '../../../shared/conversation/conversationTree'
import { conversationTreePreview } from '../../../shared/conversation/conversationTreePreview'
import { createMessageAttachmentReader } from '../attachments/publicAttachment'

export function projectConversationTree(input: {
  conversationId: string
  activeBranchId: string | null
  branches: readonly ConversationBranchRecord[]
  messages: readonly MessageRecord[]
  runs: readonly RunRecord[]
  toolCounts?: ReadonlyMap<string, number>
  usageByRun?: ReadonlyMap<string, LocalRunTokenUsage>
  attachments?: readonly AttachmentRecord[]
  outputs?: readonly LocalRunOutput[]
}): LocalConversationTree {
  const readAttachments = createMessageAttachmentReader(input.attachments ?? [])
  const outputsByRun = new Map<string, LocalRunOutput['artifacts'][number][]>()
  for (const output of input.outputs ?? []) {
    const artifacts = outputsByRun.get(output.runId) ?? []
    for (const artifact of output.artifacts) {
      if (!artifacts.some(item => item.artifactId === artifact.artifactId))
        artifacts.push(artifact)
    }
    outputsByRun.set(output.runId, artifacts)
  }
  const answerRuns = input.runs.filter(run => run.purpose !== 'conversation.compaction')
  const runNodes = new Map(answerRuns.map(run => [run.id, `answer:${run.id}`]))
  const messageNodes = new Map(input.messages.map(message => [message.id, message.role === 'user' ? `question:${message.id}` : message.runId ? runNodes.get(message.runId) ?? null : null]))
  const messagesByRun = new Map<string, MessageRecord[]>()
  for (const message of input.messages) {
    if (!message.runId)
      continue
    const messages = messagesByRun.get(message.runId) ?? []
    messages.push(message)
    messagesByRun.set(message.runId, messages)
  }
  const nodes = new Map<string, LocalConversationTreeNode>()
  const itemsByBranch = new Map<string, { node: LocalConversationTreeNode, createdAt: string }[]>()
  const add = (node: LocalConversationTreeNode, createdAt: string) => {
    nodes.set(node.id, node)
    const items = itemsByBranch.get(node.branchId) ?? []
    items.push({ node, createdAt })
    itemsByBranch.set(node.branchId, items)
  }
  for (const message of input.messages) {
    if (message.role !== 'user')
      continue
    const attachments = readAttachments(message.content)
    const quotes = readBuddyUserMessageContent(message.content)?.userContent.quotes ?? []
    add({
      id: `question:${message.id}`,
      parentId: null,
      branchId: message.branchId,
      kind: 'question',
      messageId: message.id,
      runId: null,
      text: conversationTreePreview(readText(message.content, input.attachments)
        || readBuddyUserMessageContent(message.content)?.userContent.resourceQuotes?.map(quote => `${quote.source.title}: ${quote.text}`).join('\n') || ''),
      quotes: quotes.slice(0, 3).map(quote => ({
        ...quote,
        text: quote.text.length > CONVERSATION_QUOTE_PREVIEW_LENGTH ? `${quote.text.slice(0, CONVERSATION_QUOTE_PREVIEW_LENGTH - 1)}…` : quote.text,
      })),
      quoteCount: quotes.length,
      attachments: attachments.slice(0, 3),
      attachmentCount: attachments.length,
      artifacts: [],
      artifactCount: 0,
      metadata: null,
      status: null,
      active: false,
      toolCount: 0,
      attempts: [],
    }, message.createdAt)
  }
  for (const run of answerRuns) {
    const messages = messagesByRun.get(run.id) ?? []
    const answers = messages.filter(message => message.role === 'assistant')
    const artifacts = outputsByRun.get(run.id) ?? []
    add({
      id: runNodes.get(run.id)!,
      parentId: `question:${run.triggeringMessageId}`,
      branchId: run.branchId,
      kind: 'answer',
      messageId: answers.at(-1)?.id ?? null,
      runId: run.id,
      text: conversationTreePreview(answers.map(message => readText(message.content)).filter(Boolean).join('\n\n')),
      quotes: [],
      quoteCount: 0,
      attachments: [],
      attachmentCount: 0,
      artifacts: artifacts.slice(0, 3),
      artifactCount: artifacts.length,
      metadata: {
        modelId: run.model,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        usage: input.usageByRun?.get(run.id) ?? null,
      },
      status: run.status,
      active: false,
      toolCount: input.toolCounts?.get(run.id) ?? messages.filter(message => message.role === 'tool').length,
      attempts: [{ runId: run.id, status: run.status }],
    }, run.startedAt)
  }
  const heads = new Map<string, string | null>()
  for (const branch of input.branches) {
    let parentId = branch.forkedFromMessageId ? messageNodes.get(branch.forkedFromMessageId) ?? null : null
    const items = itemsByBranch.get(branch.id) ?? []
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)
      || (a.node.kind === b.node.kind ? a.node.id.localeCompare(b.node.id) : a.node.kind === 'question' ? -1 : 1))
    for (const { node } of items) {
      if (node.kind === 'question')
        nodes.set(node.id, { ...node, parentId })
      parentId = node.id
    }
    heads.set(branch.id, parentId)
  }
  const headId = input.activeBranchId ? heads.get(input.activeBranchId) ?? null : null
  const active = new Set<string>()
  let cursor = headId
  while (cursor && !active.has(cursor)) {
    active.add(cursor)
    cursor = nodes.get(cursor)?.parentId ?? null
  }
  return {
    conversationId: input.conversationId,
    activeBranchId: input.activeBranchId,
    headId,
    nodes: [...nodes.values()].map(node => ({ ...node, active: active.has(node.id) })),
  }
}

function readText(content: unknown, attachments: readonly { id: string, name: string }[] = []): string {
  const structured = readBuddyUserMessageContent(content)
  if (structured) {
    const names = new Map(attachments.map(attachment => [attachment.id, attachment.name]))
    const resources = new Map(structured.resourceSnapshots.map(snapshot => [snapshot.resourceId, snapshot.localReference?.name ?? names.get(snapshot.attachmentId ?? '') ?? 'file']))
    const text = buddyUserContentToText(structured.userContent, id => `@${resources.get(id) ?? 'file'}`)
    return text
  }
  if (typeof content === 'string')
    return content
  if (!content || typeof content !== 'object')
    return ''
  const value = content as { text?: unknown }
  return typeof value.text === 'string' ? value.text : ''
}
