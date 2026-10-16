import type { WatchSource } from 'vue'
import axios from 'axios'
import { ref, shallowRef, watch } from 'vue'
import { errorMessage } from '@/utils/axios'

export function useResource<T>(source: WatchSource<string>, fetcher: (value: string, signal: AbortSignal) => Promise<T>) {
  const data = shallowRef<T>()
  const loading = ref(false)
  const error = ref('')
  const revision = ref(0)
  watch([source, revision], async ([value], _old, onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    loading.value = true
    error.value = ''
    data.value = undefined
    try {
      const result = await fetcher(value, controller.signal)
      if (!controller.signal.aborted)
        data.value = result
    }
    catch (cause) {
      if (!controller.signal.aborted && !axios.isCancel(cause))
        error.value = errorMessage(cause)
    }
    finally {
      if (!controller.signal.aborted)
        loading.value = false
    }
  }, { immediate: true })
  return { data, loading, error, reload: () => revision.value++ }
}
