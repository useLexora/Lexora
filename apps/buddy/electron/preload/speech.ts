import type { SpeechApi } from '../../shared/speech/speechApi'
import { ipcRenderer } from 'electron'
import { SPEECH_IPC } from '../../shared/speech/speechApi'
import { subscribe } from './subscribe'

export function createSpeechApi(): SpeechApi {
  return Object.freeze<SpeechApi>({
    voices: provider => ipcRenderer.invoke(SPEECH_IPC.voices, provider),
    microphone: active => ipcRenderer.invoke(SPEECH_IPC.microphone, active),
    catalog: () => ipcRenderer.invoke(SPEECH_IPC.catalog),
    select: input => ipcRenderer.invoke(SPEECH_IPC.select, input),
    start: input => ipcRenderer.invoke(SPEECH_IPC.start, input),
    write: input => ipcRenderer.invoke(SPEECH_IPC.write, input),
    finish: id => ipcRenderer.invoke(SPEECH_IPC.finish, { id }),
    cancel: id => ipcRenderer.invoke(SPEECH_IPC.cancel, { id }),
    acknowledge: (id, sequence) => ipcRenderer.send(SPEECH_IPC.ack, { id, sequence }),
    onChanged: listener => subscribe(SPEECH_IPC.changed, listener),
    onEvent: listener => subscribe(SPEECH_IPC.event, listener),
  })
}
