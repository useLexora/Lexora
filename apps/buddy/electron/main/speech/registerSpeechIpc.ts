import type { BrowserWindow } from 'electron'
import type { SpeechBackend } from '../../../platform/speech/SpeechBackend'
import type { SpeechProvider, SpeechStart } from '../../../shared/speech/speechApi'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { LexoraConfigStore } from '../config/LexoraConfigStore'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { SpeechSession } from '../../../platform/speech/SpeechSession'
import { SPEECH_IPC, speechAckSchema, speechChoiceSchema, speechChunkSchema, speechEnabled, speechKindSchema, speechSelectionSchema, speechSessionSchema, speechStartSchema } from '../../../shared/speech/speechApi'
import { assertTrustedSender } from '../ipc'
import { registerMicrophoneLease } from './microphonePermission'

export function registerSpeechIpc(options: {
  getWindow: () => BrowserWindow | null
  config: LexoraConfigStore
  applyConfig: (config: LexoraConfig) => Promise<void>
  backend?: SpeechBackend
}): () => Promise<void> {
  const releaseChanged = options.backend?.onChanged?.(() => {
    const window = options.getWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(SPEECH_IPC.changed)
  })
  const sessions = new Map<string, SpeechSession>()
  const channels: string[] = []
  let disposed = false
  let pending: { id: string, kind: SpeechStart['kind'], aborted: boolean } | undefined
  let releaseMicrophone: (() => void) | undefined
  let owner: BrowserWindow | null = null
  let testingMicrophone = false
  let microphoneTimer: ReturnType<typeof setTimeout> | undefined
  const cancelAll = () => Promise.all([...sessions.values()].map(session => session.cancel())).then(() => {})
  const reset = () => {
    testingMicrophone = false
    clearTimeout(microphoneTimer)
    if (pending)
      pending.aborted = true
    void cancelAll()
  }
  const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument)
      reset()
  }
  const detachOwner = () => {
    releaseMicrophone?.()
    releaseMicrophone = undefined
    owner?.removeListener('hide', reset)
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
      owner.webContents.removeListener('destroyed', reset)
      owner.webContents.removeListener('render-process-gone', reset)
      owner.webContents.removeListener('did-start-navigation', navigation)
    }
    owner = null
  }
  const bindOwner = (window: BrowserWindow) => {
    if (owner === window)
      return
    reset()
    detachOwner()
    owner = window
    releaseMicrophone = registerMicrophoneLease(window.webContents.id, () => testingMicrophone || [...sessions.values()].some(session => session.microphoneAllowed))
    window.on('hide', reset)
    window.webContents.on('destroyed', reset)
    window.webContents.on('render-process-gone', reset)
    window.webContents.on('did-start-navigation', navigation)
  }
  const providers = (): Promise<SpeechProvider[]> => options.backend?.list() ?? Promise.resolve([])
  const resolve = async (input: Pick<SpeechStart, 'provider' | 'kind'>) => {
    const provider = (await providers()).find(item => item.id === input.provider.id && item.kind === input.kind && item.revision === input.provider.revision)
    if (!provider?.supported)
      throw new Error('SPEECH_PROVIDER_UNAVAILABLE')
    return provider
  }
  const handle = (channel: string, action: (raw: unknown, window: BrowserWindow) => unknown) => {
    channels.push(channel)
    ipcMain.handle(channel, (event, raw: unknown) => {
      const window = options.getWindow()
      assertTrustedSender(event, window)
      if (disposed || !window)
        throw new Error('SPEECH_UNAVAILABLE')
      bindOwner(window)
      return action(raw, window)
    })
  }
  const assertEnabled = async (kind: SpeechStart['kind']) => {
    if (!speechEnabled((await options.config.read()).desktop.speech ?? {}, kind))
      throw new Error('SPEECH_DISABLED')
  }
  const configSubscription = options.config.onDidChange((change) => {
    if (change.kind !== 'committed')
      return
    const preferences = change.config.desktop.speech ?? {}
    if (!speechEnabled(preferences, 'speech.transcribe')) {
      testingMicrophone = false
      clearTimeout(microphoneTimer)
    }
    if (pending && !speechEnabled(preferences, pending.kind))
      pending.aborted = true
    for (const session of sessions.values()) {
      if (!speechEnabled(preferences, session.input.kind))
        void session.cancel()
    }
  })
  handle(SPEECH_IPC.microphone, async (raw) => {
    const active = z.boolean().parse(raw)
    if (active)
      await assertEnabled('speech.transcribe')
    testingMicrophone = active
    clearTimeout(microphoneTimer)
    if (testingMicrophone)
      microphoneTimer = setTimeout(() => { testingMicrophone = false }, 60000)
  })
  handle(SPEECH_IPC.catalog, async () => {
    const preferences = (await options.config.read()).desktop.speech ?? {}
    return { preferences, providers: await providers().catch(() => []) }
  })
  handle(SPEECH_IPC.voices, async (raw) => {
    const input = z.object({ id: z.string().min(1).max(256), revision: z.string().max(256), kind: speechKindSchema }).strict().parse(raw)
    return speechChoiceSchema.array().parse(await options.backend?.voices?.(await resolve({ kind: input.kind, provider: { id: input.id, revision: input.revision } })) ?? [])
  })

  handle(SPEECH_IPC.select, async (raw) => {
    const input = speechSelectionSchema.parse(raw)
    const provider = await resolve(input)
    const key = input.kind === 'speech.transcribe' ? 'transcribe' : 'synthesize'
    await options.config.update({ desktop: { speech: { [key]: { id: provider.id, title: provider.title }, ...(input.kind === 'speech.synthesize' ? { output: 'model' as const } : {}) } } }, options.applyConfig)
  })
  handle(SPEECH_IPC.start, async (raw, window) => {
    const input = speechStartSchema.parse(raw)
    if (pending || sessions.has(input.id))
      throw new Error('SPEECH_BUSY')
    const request = pending = { id: input.id, kind: input.kind, aborted: false }
    try {
      await assertEnabled(input.kind)
      const provider = await resolve(input)
      await options.backend!.prepare(provider)
      await assertEnabled(input.kind)
      await Promise.all([...sessions.values()].filter(session => session.input.kind === input.kind).map(session => session.cancel()))
      if (request.aborted || disposed || window.isDestroyed())
        throw new Error('SPEECH_UNAVAILABLE')
      const session = new SpeechSession(input, (event) => {
        if (event.type === 'ended')
          sessions.delete(input.id)
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send(SPEECH_IPC.event, event)
      })
      sessions.set(input.id, session)
      session.start(invocation => options.backend!.invoke(provider, invocation))
    }
    finally { pending = undefined }
  })
  handle(SPEECH_IPC.write, (raw) => {
    const input = speechChunkSchema.parse(raw)
    const session = sessions.get(input.id)
    if (!session)
      throw new Error('SPEECH_SESSION_ENDED')
    return session.write(input.sequence, input.bytes)
  })
  handle(SPEECH_IPC.finish, raw => sessions.get(speechSessionSchema.parse(raw).id)?.finish())
  handle(SPEECH_IPC.cancel, (raw) => {
    const { id } = speechSessionSchema.parse(raw)
    if (pending?.id === id)
      pending.aborted = true
    return sessions.get(id)?.cancel()
  })
  const acknowledge = (event: Electron.IpcMainEvent, raw: unknown) => {
    try {
      assertTrustedSender(event, options.getWindow())
    }
    catch {
      return
    }
    const input = speechAckSchema.safeParse(raw)
    if (input.success)
      sessions.get(input.data.id)?.acknowledge(input.data.sequence)
  }
  ipcMain.on(SPEECH_IPC.ack, acknowledge)
  return async () => {
    disposed = true
    releaseChanged?.()
    configSubscription.dispose()
    reset()
    if (pending)
      pending.aborted = true
    for (const channel of channels) ipcMain.removeHandler(channel)
    ipcMain.removeListener(SPEECH_IPC.ack, acknowledge)
    detachOwner()
    await cancelAll()
  }
}
