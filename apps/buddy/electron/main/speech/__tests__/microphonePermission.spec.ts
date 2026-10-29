import { expect, it } from 'vitest'
import { microphoneAllowed, registerMicrophoneLease } from '../microphonePermission'

it('grants microphone access only to an active owner and does not revoke a replacement lease', () => {
  expect(microphoneAllowed(10)).toBe(false)
  let recording = false
  const old = registerMicrophoneLease(10, () => recording)
  expect(microphoneAllowed(10)).toBe(false)
  recording = true
  expect(microphoneAllowed(10)).toBe(true)
  expect(microphoneAllowed(11)).toBe(false)
  const replacement = registerMicrophoneLease(10, () => true)
  old()
  expect(microphoneAllowed(10)).toBe(true)
  replacement()
  expect(microphoneAllowed(10)).toBe(false)
})
