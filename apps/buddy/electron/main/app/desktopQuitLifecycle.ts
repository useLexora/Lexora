import type { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'
import type { DesktopQuitOptions } from './typing'

interface DesktopQuitLifecycleOptions {
  events?: ApplicationEvents
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
      pending = Promise.resolve().then(async () => {
        options.events?.publish({ event: 'app.quit_requested', level: 'info' })
        if (!(await options.confirm(input))) {
          options.events?.publish({ event: 'app.quit_cancelled', level: 'info' })
          return
        }
        options.events?.publish({ event: 'app.quit_confirmed', level: 'info' })
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
