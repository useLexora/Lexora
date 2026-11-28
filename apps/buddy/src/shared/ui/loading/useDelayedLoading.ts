import { shallowRef, watch } from 'vue'

export function useDelayedLoading(loading: () => boolean, delay = 200) {
  const visible = shallowRef(false)
  watch(loading, (value, _, onCleanup) => {
    visible.value = false
    if (!value)
      return
    const timer = setTimeout(() => visible.value = true, delay)
    onCleanup(() => clearTimeout(timer))
  }, { immediate: true, flush: 'sync' })
  return visible
}
