import type { DocsDocumentEditorProps } from '../typing'
import { computed } from 'vue'

export function useDocumentEditor(props: DocsDocumentEditorProps) {
  const isHistoryMode = computed(() => props.mode === 'history')
  const isEditable = computed(() => props.mode === 'default' && props.editable !== false)

  return {
    isHistoryMode,
    isEditable,
  }
}
