import { shallowRef, watch } from 'vue'

export function useDocumentFind() {
  const open = shallowRef(false)
  const query = shallowRef('')
  const index = shallowRef(0)
  const count = shallowRef(0)
  const capped = shallowRef(false)
  const composing = shallowRef(false)
  const focusToken = shallowRef(0)

  watch(query, () => {
    index.value = 0
  }, { flush: 'sync' })

  function show() {
    open.value = true
    focusToken.value++
  }

  function close() {
    open.value = false
    index.value = 0
  }

  function toggle() {
    if (open.value)
      close()
    else
      show()
  }

  function next() {
    if (count.value)
      index.value = (index.value + 1) % count.value
  }

  function previous() {
    if (count.value)
      index.value = (index.value - 1 + count.value) % count.value
  }

  function setResult(nextCount: number, nextCapped: boolean) {
    capped.value = nextCapped
    count.value = nextCount
    if (index.value >= nextCount)
      index.value = 0
  }

  return { open, query, index, count, capped, composing, focusToken, show, close, toggle, next, previous, setResult }
}
