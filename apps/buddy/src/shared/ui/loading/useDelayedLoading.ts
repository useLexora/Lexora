import { shallowRef, watch } from 'vue'

export function useDelayedLoading(loading: () => boolean) {
  const visible = shallowRef(false)
  watch(loading, (value, _, onCleanup) => {
    visible.value = false
    if (!value)
      return
    const timer = setTimeout(() => visible.value = true, 200)
    onCleanup(() => clearTimeout(timer))
  }, { immediate: true, flush: 'sync' })
  return visible
}
