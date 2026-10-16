import type { MaybeRefOrGetter } from 'vue'
import { useEventListener } from '@vueuse/core'
import { onScopeDispose, toValue } from 'vue'

export type AppSaveCommandHandler = () => boolean | void | Promise<boolean | void>

export interface AppSaveCommandOptions {
  enabled?: MaybeRefOrGetter<boolean>
  handleSave: AppSaveCommandHandler
}

interface AppSaveCommandRegistration extends AppSaveCommandOptions {
  id: symbol
}

const saveCommandRegistrations: AppSaveCommandRegistration[] = []

export function isAppSaveShortcutEvent(event: KeyboardEvent) {
  return event.key.toLowerCase() === 's'
    && (event.ctrlKey || event.metaKey)
    && !event.shiftKey
    && !event.altKey
}

export function registerAppSaveCommand(options: AppSaveCommandOptions) {
  const registration: AppSaveCommandRegistration = {
    id: Symbol('app-save-command'),
    ...options,
  }

  saveCommandRegistrations.push(registration)

  return () => {
    const index = saveCommandRegistrations.indexOf(registration)

    if (index < 0) {
      return
    }

    saveCommandRegistrations.splice(index, 1)
  }
}

export function useAppSaveCommand(options: AppSaveCommandOptions) {
  const unregister = registerAppSaveCommand(options)

  onScopeDispose(unregister)

  return unregister
}

export async function runAppSaveCommand() {
  const registrations = [...saveCommandRegistrations].reverse()

  for (const registration of registrations) {
    if (registration.enabled !== undefined && !toValue(registration.enabled)) {
      continue
    }

    const handled = await registration.handleSave()

    if (handled !== false) {
      return true
    }
  }

  return false
}

export function useAppSaveShortcut() {
  return useEventListener('keydown', (event) => {
    if (!isAppSaveShortcutEvent(event)) {
      return
    }

    event.preventDefault()
    void runAppSaveCommand()
  }, { capture: true })
}
