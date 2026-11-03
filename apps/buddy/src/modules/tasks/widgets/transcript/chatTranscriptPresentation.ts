import type { InjectionKey, Ref } from 'vue'
import { computed, inject, provide, shallowReactive, shallowRef, toValue, watch } from 'vue'

interface ChatTranscriptPresentation {
  values: Map<string, Map<string, unknown>>
  rowKeys: Readonly<Ref<ReadonlySet<string>>>
  generation: Readonly<Ref<number>>
}

interface ChatTranscriptRowState {
  presentation: ChatTranscriptPresentation
  rowKey: () => string
  generation: number
}

const presentationKey: InjectionKey<ChatTranscriptPresentation> = Symbol('chatTranscriptPresentation')
const rowStateKey: InjectionKey<ChatTranscriptRowState | null> = Symbol('chatTranscriptRowState')

export function provideChatTranscriptPresentation(scope: () => string, rowKeys: () => readonly string[]) {
  const values = shallowReactive(new Map<string, Map<string, unknown>>())
  const keys = computed(() => new Set(rowKeys()))
  const generation = shallowRef(0)
  watch(scope, () => {
    generation.value += 1
    values.clear()
  }, { flush: 'sync' })
  watch(keys, (current) => {
    for (const key of values.keys()) {
      if (!current.has(key))
        values.delete(key)
    }
  })
  provide(presentationKey, { values, rowKeys: keys, generation })
  provide(rowStateKey, null)
}

export function provideChatTranscriptRowState(rowKey: () => string) {
  const presentation = inject(presentationKey, null)
  provide(rowStateKey, presentation ? { presentation, rowKey, generation: presentation.generation.value } : null)
}

export function useChatTranscriptValue<T>(key: string | (() => string), initialValue: T): Ref<T> {
  const row = inject(rowStateKey, null)
  if (!row)
    return shallowRef(initialValue)

  return computed({
    get() {
      if (row.generation !== row.presentation.generation.value)
        return initialValue
      const values = row.presentation.values.get(row.rowKey())
      const name = toValue(key)
      return values?.has(name) ? values.get(name) as T : initialValue
    },
    set(value: T) {
      if (row.generation !== row.presentation.generation.value)
        return
      const id = row.rowKey()
      if (!row.presentation.rowKeys.value.has(id))
        return
      let values = row.presentation.values.get(id)
      if (!values) {
        values = shallowReactive(new Map<string, unknown>())
        row.presentation.values.set(id, values)
      }
      values.set(toValue(key), value)
    },
  })
}
