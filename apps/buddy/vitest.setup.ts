import process from 'node:process'
import { Temporal } from '@buddy-shared/automation/temporal'
import { afterEach, vi } from 'vitest'
import { createBuddyNativeEnvironment } from './platform/native/nativeHost'

Object.assign(globalThis, { Temporal: { ...Temporal } })
Object.assign(process.env, createBuddyNativeEnvironment({ appPath: import.meta.dirname, resourcesPath: '', isPackaged: false }))

afterEach(() => {
  vi.useRealTimers()
})
