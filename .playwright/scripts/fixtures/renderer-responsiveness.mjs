import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'

export function startKeyboardProbe(session) {
  let pending
  let failure
  const dispatch = () => {
    if (pending || failure)
      return
    pending = (async () => {
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F24', code: 'F24', windowsVirtualKeyCode: 135, timestamp: Date.now() / 1000 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F24', code: 'F24', windowsVirtualKeyCode: 135 })
    })().catch(error => failure = error).finally(() => pending = undefined)
  }
  const timer = setInterval(dispatch, 16)
  dispatch()
  return async () => {
    clearInterval(timer)
    await pending
    if (failure)
      throw failure
  }
}

export async function stopRendererTrace(session, filename) {
  const complete = new Promise(resolve => session.once('Tracing.tracingComplete', resolve))
  await session.send('Tracing.end')
  const { stream } = await complete
  const file = await fs.open(filename, 'w')
  try {
    let eof = false
    while (!eof) {
      const chunk = await session.send('IO.read', { handle: stream, size: 1024 * 1024 })
      await file.write(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'))
      eof = chunk.eof
    }
  }
  finally {
    await file.close()
    await session.send('IO.close', { handle: stream })
  }
}
