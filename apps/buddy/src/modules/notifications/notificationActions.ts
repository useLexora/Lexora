import type { DesktopNotification } from './contracts'

type Action = DesktopNotification['action']
export type RegisterNotificationAction = <K extends Action['type']>(
  type: K,
  handle: (action: Extract<Action, { type: K }>) => void | Promise<void>,
) => () => void

export function createNotificationActions() {
  const handlers = new Map<Action['type'], (action: Action) => void | Promise<void>>()
  const register: RegisterNotificationAction = (type, handle) => {
    if (handlers.has(type))
      throw new Error(`Notification action already registered: ${type}`)
    const handler = handle as (action: Action) => void | Promise<void>
    handlers.set(type, handler)
    return () => {
      if (handlers.get(type) === handler)
        handlers.delete(type)
    }
  }
  function dispatch(action: Action) {
    const handle = handlers.get(action.type)
    if (!handle)
      throw new Error(`Unknown notification action: ${action.type}`)
    return handle(action)
  }
  return { register, dispatch }
}
