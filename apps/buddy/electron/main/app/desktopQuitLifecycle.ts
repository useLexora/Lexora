import type { DesktopExitBehavior } from '../../../shared/lifecycle/exitBehavior'
import type { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'
import type { DesktopQuitOptions } from './typing'

interface DesktopQuitLifecycleOptions {
  events?: ApplicationEvents
  getExitBehavior?: () => DesktopExitBehavior
  closeDesktop?: () => Promise<void>
  restartDesktop?: () => Promise<void>
  confirm: (options: DesktopQuitOptions) => Promise<boolean>
  dispose: () => Promise<void>
  quit: (restart: boolean) => void
  exit: () => void
}

export function createDesktopQuitLifecycle(options: DesktopQuitLifecycleOptions) {
  let committed = false
  let quitting = false
  let pending: Promise<void> | null = null

  return {
    get committed() { return committed },
    get quitting() { return quitting },
    request(input: DesktopQuitOptions = {}, prepare?: () => Promise<(() => void) | void>): Promise<void> {
      if (pending)
        return pending
      const behavior = input.reason || input.restart || prepare ? 'stop_service' : options.getExitBehavior?.() ?? 'stop_service'
      pending = Promise.resolve().then(async () => {
        options.events?.publish({ event: 'app.quit_requested', level: 'info' })
        if (!(await options.confirm(input))) {
          options.events?.publish({ event: 'app.quit_cancelled', level: 'info' })
          return
        }
        options.events?.publish({ event: 'app.quit_confirmed', level: 'info' })
        if (behavior === 'keep_service') {
          if (!options.closeDesktop)
            throw new Error('DESKTOP_EXIT_SCOPE_UNAVAILABLE')
          await options.closeDesktop()
          return
        }
        if (input.restart && options.restartDesktop && !prepare) {
          await options.restartDesktop()
          quitting = true
          committed = true
          return
        }
        const finish = prepare ? await prepare() : undefined
        quitting = true
        await options.dispose()
        committed = true
        if (finish)
          finish()
        else
          options.quit(input.restart === true)
      }).catch((error) => {
        if (quitting)
          options.exit()
        throw error
      }).finally(() => {
        if (!committed)
          pending = null
      })
      return pending
    },
  }
}
