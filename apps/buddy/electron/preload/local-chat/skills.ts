import type { SkillChangeNotice, SkillInstallPreview } from '../../../shared/skills/skillApi'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function createSkillsApi(): Pick<LocalChatApi, 'skills'> {
  return { skills: Object.freeze({
    list: (spaceId, metadataOnly) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsList, { spaceId: spaceId ?? null, metadataOnly }),
    get: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsGet, { ...input }),
    listFiles: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsListFiles, { ...input }),
    readFile: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsReadFile, { ...input }),
    revealFile: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsRevealFile, { ...input }),
    preview: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsPreview, { ...input, source: { ...input.source } }),
    previewLocal: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsPreviewLocal, { ...input }),
    install: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsInstall, { ...input, candidateIds: [...input.candidateIds] }),
    discard: previewId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsDiscard, { previewId }),
    setEnabled: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsSetEnabled, { ...input }),
    remove: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsRemove, { ...input }),
    reveal: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.skillsReveal, { ...input }),
    onChanged(listener) {
      const handle = (_event: Electron.IpcRendererEvent, input: SkillChangeNotice) => listener(Object.freeze({ ...input }))
      ipcRenderer.on(LOCAL_CHAT_IPC_CHANNELS.skillsChanged, handle)
      return () => ipcRenderer.removeListener(LOCAL_CHAT_IPC_CHANNELS.skillsChanged, handle)
    },
    onReview(listener) {
      const handle = (_event: Electron.IpcRendererEvent, preview: SkillInstallPreview) => listener(preview)
      ipcRenderer.on(LOCAL_CHAT_IPC_CHANNELS.skillsReviewRequested, handle)
      return () => ipcRenderer.removeListener(LOCAL_CHAT_IPC_CHANNELS.skillsReviewRequested, handle)
    },
  }) }
}
