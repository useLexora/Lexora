import { useMessage } from 'naive-ui'

const visible = new WeakMap<ReturnType<typeof useMessage>, Set<string>>()

export function useTaskErrorMessage() {
  const message = useMessage()
  const active = visible.get(message) ?? new Set<string>()
  visible.set(message, active)
  return (text: string) => {
    if (!active.has(text)) {
      active.add(text)
      message.error(text, { onAfterLeave: () => active.delete(text) })
    }
  }
}
