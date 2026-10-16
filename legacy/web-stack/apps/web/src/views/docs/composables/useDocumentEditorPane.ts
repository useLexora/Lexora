import type { DocsDocumentEditorPaneProps } from '../typing'
import { DOCUMENT_PANE_STATE } from '@haohaoxue/lexora-contracts/document/constants'
import { computed, shallowRef, watch } from 'vue'

export function useDocumentEditorPane(options: {
  onRetryLoad: () => void
  props: DocsDocumentEditorPaneProps
}) {
  const contentError = shallowRef<Error | null>(null)
  const shouldShowEditor = computed(() =>
    Boolean(options.props.document)
    && options.props.paneState === DOCUMENT_PANE_STATE.READY
    && !contentError.value,
  )

  watch(
    () => options.props.document
      ? JSON.stringify({
          title: options.props.document.title,
          body: options.props.document.body,
        })
      : null,
    () => {
      contentError.value = null
    },
  )

  function handleContentError(error: Error) {
    contentError.value = error
  }

  function handleRetryLoad() {
    contentError.value = null
    options.onRetryLoad()
  }

  return {
    contentError,
    handleContentError,
    handleRetryLoad,
    shouldShowEditor,
  }
}
