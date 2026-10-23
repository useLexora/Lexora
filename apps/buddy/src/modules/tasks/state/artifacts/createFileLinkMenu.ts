import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { TaskCapability, TaskResourcePanel } from '../../contracts'
import type { createArtifactActions } from './createArtifactActions'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { FileOpeningState } from '@/modules/files'
import type { FileLinkMenuAction } from '@/shared/ui/markdown/fileLinkMenu'
import { localFileLinkPath } from '@buddy-shared/files/fileLink'
import { fileOpeningTitle } from '@buddy-shared/files/fileOpening'
import { translateBuddy } from '@/i18n/buddyI18n'
import { resolveChatToolFileTarget } from '../../model/transcript/chatToolFileTarget'

interface FileLinkMenuOptions {
  resources: TaskResourcePanel
  task: () => TaskCapability | null
  artifacts: ReturnType<typeof createArtifactActions>
  files: LocalChatApi['taskFiles']
  opening: Pick<FileOpeningState, 'ensureReady' | 'resolve'>
  language: () => BuddyLocale
  writeClipboardText: (text: string) => Promise<void>
}

export function createFileLinkMenu(options: FileLinkMenuOptions) {
  return async (href: string, source?: ContextPanelSource): Promise<readonly FileLinkMenuAction[]> => {
    const path = localFileLinkPath(href)
    const conversationId = source?.conversationId ?? options.task()?.session.activeTaskId.value
    if (!path || !conversationId)
      return []
    const task = options.task()
    const branchId = task?.workspace.session.activeBranchId.value
    const draftId = task?.workspace.composer.draftId.value
    const current = () => options.task() === task && task?.session.activeTaskId.value === conversationId
      && task.workspace.session.activeBranchId.value === branchId && task.workspace.composer.draftId.value === draftId
    const artifact = options.resources.fileArtifact(href, source)
    const name = artifact?.name ?? path.split(/[\\/]/).at(-1) ?? path
    const t = (key: Parameters<typeof translateBuddy>[1]) => translateBuddy(options.language(), key)
    const resolve = () => options.files.resolve({ conversationId, href })
    const run = (action: () => void | Promise<void>) => async () => {
      if (current())
        await action()
    }
    try {
      await options.opening.ensureReady()
    }
    catch (error) {
      if (current())
        options.resources.onFileError(error)
      return []
    }
    if (!current())
      return []
    const opening = options.opening.resolve(name, 'standalone')
    const spaceTarget = resolveChatToolFileTarget(task?.session.activeSpace.value ?? null, href)
    return [
      { key: 'open', label: t('desktop.fileLink.open'), run: run(() => options.resources.previewFile(href, source)) },
      ...(opening.candidates.length && artifact?.kind !== 'directory'
        ? [{
            key: 'openWith',
            label: t('desktop.fileLink.openWith'),
            children: opening.candidates.map(provider => ({ key: provider.id, label: fileOpeningTitle(provider, options.language()), run: run(() => options.resources.previewFile(href, source, provider.id)) })),
          }]
        : []),
      { key: 'reference', label: t('desktop.artifacts.reference'), disabled: artifact ? !options.artifacts.canReference(artifact) : !options.artifacts.canReferenceFile(conversationId), run: run(async () => {
        if (artifact) {
          await options.artifacts.execute('reference', artifact)
        }
        else {
          const file = await resolve()
          if (current())
            await options.artifacts.referenceFile(conversationId, file.target.path)
        }
      }) },
      { key: 'locate', label: t('desktop.artifacts.locate'), disabled: artifact ? !options.artifacts.canLocate(artifact) : !spaceTarget, run: run(async () => {
        if (artifact) {
          await options.artifacts.execute('locate', artifact)
        }
        else {
          const file = await resolve()
          if (current() && spaceTarget)
            options.resources.locateFile(spaceTarget, file.kind, source)
        }
      }) },
      { key: 'reveal', label: t('desktop.artifacts.reveal'), run: run(async () => {
        if (artifact) {
          await options.artifacts.execute('reveal', artifact)
        }
        else {
          const file = await resolve()
          if (current())
            await options.files.revealFile(file.target)
        }
      }) },
      { key: 'copyPath', label: t('desktop.artifacts.copyPath'), run: run(async () => {
        const value = artifact?.path ?? (await resolve()).target.path
        if (current())
          await options.writeClipboardText(value)
      }) },
    ]
  }
}
