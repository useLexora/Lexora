import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { SpeechPreferences, SpeechProvider } from '../../../../shared/speech/speechApi'
import type { LexoraConfigPatch } from '../../../shared/desktopApi'
import type { LexoraConfigStore } from '../../config/LexoraConfigStore'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { SPEECH_IPC } from '../../../../shared/speech/speechApi'
import { registerSpeechIpc } from '../registerSpeechIpc'

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>())
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input?: unknown) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: () => {},
    removeListener: () => {},
  },
}))

it('persists a selection before preparation; a failed start preserves that selection', async () => {
  const speech: SpeechPreferences = {}
  const config = {
    read: async () => ({ desktop: { speech } }),
    update: async (patch: LexoraConfigPatch) => { Object.assign(speech, patch.desktop?.speech) },
    onDidChange: () => ({ dispose() {} }),
  } as unknown as LexoraConfigStore
  const frame = {}
  const contents = Object.assign(new EventEmitter(), { id: 101, mainFrame: frame, isDestroyed: () => false, send: () => {} })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }) as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const model: SpeechProvider = { id: 'fixture:voice', title: 'Fixture voice', revision: 'current', kind: 'speech.synthesize', supported: true, streamingInput: false, streamingOutput: false }
  const dispose = registerSpeechIpc({
    config,
    getWindow: () => window,
    applyConfig: async () => {},
    backend: {
      list: async () => [model],
      prepare: async () => { throw new Error('SPEECH_NOT_CONFIGURED') },
      invoke: async () => { throw new Error('SPEECH_FAILED') },
    },
  })
  try {
    await handlers.get(SPEECH_IPC.select)!(event, { kind: model.kind, provider: { id: model.id, revision: model.revision } })
    expect(speech).toEqual({ output: 'model', synthesize: { id: model.id, title: model.title } })
    await expect(handlers.get(SPEECH_IPC.start)!(event, { id: '7e249980-d382-4d9f-b2f6-030c11e6c54d', kind: model.kind, provider: { id: model.id, revision: model.revision }, text: 'Hello' })).rejects.toThrow('SPEECH_NOT_CONFIGURED')
    expect(speech).toEqual({ output: 'model', synthesize: { id: model.id, title: model.title } })
    speech.output = 'system'
    expect(await handlers.get(SPEECH_IPC.catalog)!(event)).toMatchObject({ preferences: { output: 'system', synthesize: { id: model.id } } })
  }
  finally { await dispose() }
})
