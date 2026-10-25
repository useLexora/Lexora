import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { NOTIFICATION_SOUND_MAX_BYTES, NOTIFICATION_SOUND_MAX_DURATION_MS } from '../../../shared/notifications/notificationSound'

export type NotificationAudioOwner = 'preview' | 'notification'
export type NotificationAudioFailure = 'type' | 'duration'

export class NotificationAudioError extends Error {
  readonly reason: NotificationAudioFailure

  constructor(reason: NotificationAudioFailure) {
    super(`NOTIFICATION_AUDIO_${reason.toUpperCase()}`)
    this.reason = reason
  }
}

const AUDIO_HOST_SOURCE = String.raw`
(() => {
  let context;
  let source;
  let prepared;
  let owner;
  let generation = 0;
  const stop = (target) => {
    if (target !== 'all' && owner !== target) return;
    generation++;
    owner = undefined;
    prepared = undefined;
    if (source) {
      source.stop();
      source.disconnect();
      source = undefined;
    }
  };
  const decode = async ({ base64, mimeType, maxDurationMs }) => {
    const audio = new Audio();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('type')), 8000);
        const done = (error) => {
          clearTimeout(timer);
          audio.onloadedmetadata = null;
          audio.onerror = null;
          error ? reject(error) : resolve();
        };
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => done();
        audio.onerror = () => done(new Error('type'));
        audio.src = 'data:' + mimeType + ';base64,' + base64;
      });
      if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration * 1000 > maxDurationMs + 1)
        throw new Error('duration');
    } finally {
      audio.removeAttribute('src');
      audio.load();
    }
    context ??= new AudioContext();
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    const durationMs = Math.ceil(buffer.duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > maxDurationMs)
      throw new Error('duration');
    return { buffer, durationMs };
  };
  globalThis.notificationAudio = {
    async inspect(input) {
      try {
        const { durationMs } = await decode(input);
        return { status: 'ok', durationMs };
      } catch (error) {
        return { status: 'failed', reason: error.message === 'duration' ? 'duration' : 'type' };
      }
    },
    async prepare(input) {
      stop('all');
      const version = generation;
      owner = input.owner;
      try {
        const { buffer, durationMs } = await decode(input);
        if (version !== generation) return { status: 'cancelled' };
        await context.resume();
        if (version !== generation) return { status: 'cancelled' };
        prepared = { buffer, volume: input.volume, version };
        return { status: 'ok', durationMs, token: version };
      } catch (error) {
        if (version === generation) stop('all');
        return { status: 'failed', reason: error.message === 'duration' ? 'duration' : 'type' };
      }
    },
    start(token) {
      if (!prepared || prepared.version !== token || generation !== token) return false;
      const gain = context.createGain();
      gain.gain.value = prepared.volume;
      source = context.createBufferSource();
      const playing = source;
      source.buffer = prepared.buffer;
      prepared = undefined;
      source.connect(gain);
      gain.connect(context.destination);
      source.onended = () => {
        playing.disconnect();
        gain.disconnect();
        if (source === playing) {
          source = undefined;
          owner = undefined;
        }
      };
      source.start();
      return true;
    },
    discard(token) {
      if (prepared && prepared.version === token) stop('all');
    },
    stop,
  };
})();
`

const scriptHash = createHash('sha256').update(AUDIO_HOST_SOURCE).digest('base64')
const AUDIO_HOST_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; media-src data:"><title>Lexora notification audio</title><script>${AUDIO_HOST_SOURCE}</script>`)}`

type AudioResult = { status: 'ok', durationMs: number } | { status: 'failed', reason: NotificationAudioFailure }

export class NotificationAudioPlayer {
  #window: BrowserWindow | null = null
  #ready: Promise<BrowserWindow> | null = null
  #disposed = false

  async inspect(bytes: Uint8Array, mimeType: string): Promise<number> {
    const window = await this.#getWindow()
    return this.#result(await this.#execute<AudioResult>(window, 'inspect', this.#input(bytes, mimeType)))
  }

  async play(bytes: Uint8Array, mimeType: string, volume: number, owner: NotificationAudioOwner, isCurrent: () => boolean): Promise<number> {
    const window = await this.#getWindow()
    if (!isCurrent())
      return 0
    const result = await this.#execute<(AudioResult & { token?: number }) | { status: 'cancelled' }>(window, 'prepare', { ...this.#input(bytes, mimeType), volume, owner })
    if (result.status === 'cancelled')
      return 0
    const durationMs = this.#result(result)
    if (!isCurrent()) {
      await this.#execute(window, 'discard', result.token)
      return 0
    }
    return await this.#execute<boolean>(window, 'start', result.token) ? durationMs : 0
  }

  async stop(owner: NotificationAudioOwner | 'all'): Promise<void> {
    const window = await this.#ready?.catch(() => null)
    if (window && !window.isDestroyed())
      await this.#execute(window, 'stop', owner)
  }

  dispose(): void {
    this.#disposed = true
    this.#destroy()
  }

  #input(bytes: Uint8Array, mimeType: string) {
    if (bytes.byteLength === 0 || bytes.byteLength > NOTIFICATION_SOUND_MAX_BYTES || !['audio/wav', 'audio/mpeg'].includes(mimeType))
      throw new NotificationAudioError('type')
    return { base64: Buffer.from(bytes).toString('base64'), mimeType, maxDurationMs: NOTIFICATION_SOUND_MAX_DURATION_MS }
  }

  #result(result: AudioResult): number {
    if (result.status !== 'ok')
      throw new NotificationAudioError(result.reason)
    if (!Number.isFinite(result.durationMs) || result.durationMs <= 0 || result.durationMs > NOTIFICATION_SOUND_MAX_DURATION_MS)
      throw new NotificationAudioError('duration')
    return result.durationMs
  }

  #getWindow(): Promise<BrowserWindow> {
    if (this.#disposed)
      return Promise.reject(new Error('NOTIFICATION_AUDIO_DISPOSED'))
    if (this.#ready)
      return this.#ready
    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        partition: 'lexora-notification-audio',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    })
    this.#window = window
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('render-process-gone', () => this.#destroy())
    window.once('closed', () => {
      if (this.#window === window) {
        this.#window = null
        this.#ready = null
      }
    })
    this.#ready = this.#bounded(window.loadURL(AUDIO_HOST_URL), window).then(() => window).catch((error) => {
      if (this.#window === window)
        this.#destroy()
      throw error
    })
    return this.#ready
  }

  #execute<T>(window: BrowserWindow, method: 'inspect' | 'prepare' | 'start' | 'discard' | 'stop', input: unknown): Promise<T> {
    return this.#bounded(window.webContents.executeJavaScript(`globalThis.notificationAudio.${method}(${JSON.stringify(input)})`), window)
  }

  async #bounded<T>(operation: Promise<T>, window: BrowserWindow): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (this.#window === window)
              this.#destroy()
            reject(new Error('NOTIFICATION_AUDIO_TIMEOUT'))
          }, 12_000)
        }),
      ])
    }
    finally {
      clearTimeout(timer)
    }
  }

  #destroy(): void {
    const window = this.#window
    this.#window = null
    this.#ready = null
    if (window && !window.isDestroyed())
      window.destroy()
  }
}
