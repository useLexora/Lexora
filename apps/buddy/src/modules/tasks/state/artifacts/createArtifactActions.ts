import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { TaskCapability, TaskResourcePanel } from '../../contracts'
import { artifactFileTarget } from '../../model/artifacts/artifactFileTarget'

export interface ArtifactActionsOptions {
  task: () => TaskCapability | null
  resources: Pick<TaskResourcePanel, 'locateFile'>
  revealFile: LocalChatApi['artifacts']['revealFile']
  writeClipboardText: (text: string) => Promise<void>
}

export type ArtifactAction = 'reference' | 'locate' | 'reveal' | 'copyPath'

export function createArtifactActions(options: ArtifactActionsOptions) {
  function referenceTask(artifact: LocalArtifact) {
    const task = options.task()
    const workspace = task?.workspace
    return workspace && workspace.session.activeConversationId.value === artifact.conversationId
      && workspace.session.activeBranchId.value
      && workspace.restoration.state.value === 'ready' && !workspace.status.isClosing.value
      && !workspace.execution.isSending.value && !workspace.execution.isMutatingBranch.value
      ? task
      : null
  }
  function fileTarget(artifact: LocalArtifact) {
    const task = options.task()
    return task?.workspace.session.activeConversationId.value === artifact.conversationId
      ? artifactFileTarget(task.workspace.session.activeSpace.value, artifact.path)
      : null
  }
  return {
    canReference: (artifact: LocalArtifact) => !!referenceTask(artifact),
    canLocate: (artifact: LocalArtifact) => !!fileTarget(artifact),
    async execute(action: ArtifactAction, artifact: LocalArtifact): Promise<void> {
      if (action === 'copyPath')
        return options.writeClipboardText(artifact.path)
      if (action === 'reveal') {
        await options.revealFile({ artifactId: artifact.artifactId })
        return
      }
      if (action === 'locate') {
        const target = fileTarget(artifact)
        if (!target)
          throw new Error('ARTIFACT_FILE_TARGET_UNAVAILABLE')
        options.resources.locateFile(target, artifact.kind, { conversationId: artifact.conversationId, runId: artifact.runId })
        return
      }
      const task = referenceTask(artifact)
      if (!task)
        throw new Error('ARTIFACT_REFERENCE_UNAVAILABLE')
      const { composer, session } = task.workspace
      const draftId = composer.draftId.value
      const editorKey = composer.editorKey.value
      const branchId = session.activeBranchId.value!
      const resourceId = await composer.selectSource({ artifactId: artifact.artifactId, conversationId: artifact.conversationId, branchId }, draftId)
      if (!resourceId || options.task() !== task || referenceTask(artifact) !== task
        || composer.draftId.value !== draftId || composer.editorKey.value !== editorKey || session.activeBranchId.value !== branchId) {
        return
      }
      const content = composer.composerContent.value
      composer.updateComposerContent(composer.draft.value, {
        ...content,
        attrs: { ...content.attrs, panelResourceIds: [...new Set([...content.attrs?.panelResourceIds ?? [], resourceId])] },
      })
    },
  }
}
