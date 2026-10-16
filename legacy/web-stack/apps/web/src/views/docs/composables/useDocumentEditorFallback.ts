import type { DocsDocumentEditorFallbackProps } from '../typing'
import { computed } from 'vue'
import {
  resolveDocumentEditorFallbackState,
} from '../utils/documentEditorFallback'

export function useDocumentEditorFallback(options: {
  onCreateDocument: () => void
  onOpenFallbackDocument: () => void
  onRetryLoad: () => void
  props: DocsDocumentEditorFallbackProps
}) {
  const fallbackState = computed(() => resolveDocumentEditorFallbackState(options.props))

  function emitAction(event: 'createDocument' | 'openFallbackDocument' | 'retryLoad') {
    switch (event) {
      case 'createDocument':
        options.onCreateDocument()
        return
      case 'openFallbackDocument':
        options.onOpenFallbackDocument()
        return
      case 'retryLoad':
        options.onRetryLoad()
    }
  }

  return {
    emitAction,
    fallbackState,
  }
}
