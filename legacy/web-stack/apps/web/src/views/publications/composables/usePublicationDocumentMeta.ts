import type { WatchSource } from 'vue'
import type { PublicationDocumentMetaInput } from '../typing'
import { onBeforeUnmount, watch } from 'vue'

export function usePublicationDocumentMeta(input: {
  allowIndexing: WatchSource<PublicationDocumentMetaInput['allowIndexing']>
  title: WatchSource<PublicationDocumentMetaInput['title']>
}) {
  const previousDocumentTitle = typeof document === 'undefined' ? '' : document.title

  watch(
    [input.title, input.allowIndexing],
    ([title, allowIndexing]) => {
      applyPublicationDocumentMeta({ title, allowIndexing })
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    if (typeof document === 'undefined') {
      return
    }

    document.title = previousDocumentTitle
    document.querySelector('meta[data-publication-robots="true"]')?.remove()
  })
}

function applyPublicationDocumentMeta(input: PublicationDocumentMetaInput) {
  if (typeof document === 'undefined') {
    return
  }

  document.title = input.title ? `${input.title} - Lexora` : 'Lexora'

  const robotsMeta = resolvePublicationRobotsMeta()
  robotsMeta.setAttribute('content', input.allowIndexing ? 'index,follow' : 'noindex,nofollow')
}

function resolvePublicationRobotsMeta(): HTMLMetaElement {
  const existingMeta = document.querySelector<HTMLMetaElement>('meta[data-publication-robots="true"]')

  if (existingMeta) {
    return existingMeta
  }

  const meta = document.createElement('meta')
  meta.setAttribute('name', 'robots')
  meta.setAttribute('data-publication-robots', 'true')
  document.head.append(meta)
  return meta
}
