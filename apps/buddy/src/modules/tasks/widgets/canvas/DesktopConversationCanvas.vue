<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalConversationTreeNode } from '@buddy-shared/conversation/conversationTree'
import type { TaskChatWorkspace } from '../../contracts'
import type { ConversationCanvasNode } from '../../model/canvas/conversationCanvasLayout'
import { conversationTreePreview } from '@buddy-shared/conversation/conversationTreePreview'
import { computed, nextTick, onBeforeUnmount, useTemplateRef, watch } from 'vue'
import { createChatRunTranscriptProjector } from '../../model/transcript/chatRunTranscriptProjector'
import ConversationCanvas from './ConversationCanvas.vue'

const props = defineProps<{ workspace: TaskChatWorkspace, active: boolean, selectedNodeId: string | null }>()
const emit = defineEmits<{ focusComposer: [], openNode: [node: LocalConversationTreeNode], editNode: [node: LocalConversationTreeNode], openQuote: [messageId: string, quoteId: string], openNodeArtifact: [artifact: LocalArtifact] }>()
const canvasRef = useTemplateRef<InstanceType<typeof ConversationCanvas>>('canvasRef')
const tree = computed(() => props.workspace.tree.data.value)
const followup = computed(() => {
  const target = props.workspace.composer.target.value
  return target.kind === 'message_followup'
    ? tree.value?.nodes.find(node => node.messageId === target.assistantMessageId) ?? null
    : null
})
const projector = createChatRunTranscriptProjector()
const nodes = computed<readonly ConversationCanvasNode[]>(() => {
  const run = props.workspace.execution.activeRun.value
  const projection = props.active && run ? projector.project(props.workspace.transcript.runEventBuckets.value, [run])[0] : null
  const streaming = projection?.streamingMessages.map(item => item.text).join('\n\n') ?? ''
  const outputs = props.workspace.transcript.runOutputs.value.filter(output => output.runId === run?.id)
  const artifacts = [...new Map(outputs.flatMap(output => output.artifacts).map(artifact => [artifact.artifactId, artifact])).values()]
  const nodes: ConversationCanvasNode[] = (tree.value?.nodes ?? []).map(node => node.runId === run?.id && run
    ? {
        ...node,
        text: streaming ? conversationTreePreview(streaming, true) : node.text,
        status: run.status,
        toolCount: projection ? projection.turn.nodes.filter(item => item.kind === 'tool').length : node.toolCount,
        artifacts: artifacts.length ? artifacts.slice(0, 3) : node.artifacts,
        artifactCount: artifacts.length || node.artifactCount,
        metadata: {
          modelId: run.modelId,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          usage: projection?.turn.usage ?? node.metadata?.usage ?? null,
        },
      }
    : node)
  if (followup.value) {
    nodes.push({
      ...followup.value,
      id: 'draft:followup',
      parentId: followup.value.id,
      kind: 'draft',
      messageId: null,
      runId: null,
      text: '',
      quotes: [],
      quoteCount: 0,
      status: null,
      toolCount: 0,
      attempts: [],
      attachments: [],
      attachmentCount: 0,
      artifacts: [],
      artifactCount: 0,
      metadata: null,
    })
  }
  return nodes
})

async function beginFollowup(id: string) {
  const node = tree.value?.nodes.find(node => node.id === id)
  const conversationId = props.workspace.session.activeConversationId.value
  if (!conversationId || !node?.messageId || node.kind !== 'answer' || node.status !== 'completed')
    return
  if (await props.workspace.execution.beginFollowup({ kind: 'message_followup', conversationId, branchId: node.branchId, assistantMessageId: node.messageId })) {
    await nextTick()
    canvasRef.value?.focusNode('draft:followup')
    emit('focusComposer')
  }
}

async function retry(id: string) {
  const node = tree.value?.nodes.find(node => node.id === id)
  if (node?.runId && await props.workspace.execution.regenerateAssistant(node.runId))
    await props.workspace.tree.refresh()
}

async function openNode(id: string) {
  if (id === 'draft:followup') {
    emit('focusComposer')
    return
  }
  const node = tree.value?.nodes.find(node => node.id === id)
  if (node) {
    emit('openNode', node)
    await nextTick()
    canvasRef.value?.focusNode(id)
  }
}

function openArtifact(id: string) {
  const artifact = nodes.value.flatMap(node => node.artifacts).find(artifact => artifact.artifactId === id)
  if (artifact)
    emit('openNodeArtifact', artifact)
}

async function editNode(id: string) {
  const node = tree.value?.nodes.find(node => node.id === id)
  if (node?.kind === 'question') {
    emit('editNode', node)
    await nextTick()
    canvasRef.value?.focusNode(id)
  }
}

defineExpose({
  focusNode: (id: string) => canvasRef.value?.focusNode(id),
})

watch(() => props.active, value => props.workspace.tree.setVisible(value), { immediate: true })
onBeforeUnmount(() => props.workspace.tree.setVisible(false))
</script>

<template>
  <ConversationCanvas
    ref="canvasRef"
    :nodes="nodes"
    :conversation-id="workspace.session.activeConversationId.value"
    :can-mutate="workspace.execution.canMutateBranch.value"
    :language="workspace.language.value"
    :active="active"
    :loading="workspace.tree.loading.value"
    :error="workspace.tree.error.value"
    :selected-node-id="selectedNodeId"
    @followup="beginFollowup"
    @retry="retry"
    @open="openNode"
    @edit="editNode"
    @open-artifact="openArtifact"
    @open-quote="(messageId, quoteId) => emit('openQuote', messageId, quoteId)"
    @refresh="workspace.tree.refresh"
  />
</template>
