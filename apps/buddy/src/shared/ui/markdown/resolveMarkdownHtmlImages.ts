import type { MarkdownImageResolver } from './markdownImage'
import type { MarkdownHtmlPendingImage, MarkdownHtmlRemoteImage } from './safeMarkdownHtml'

export function resolveMarkdownHtmlImages(
  pendingImages: readonly MarkdownHtmlPendingImage[],
  remoteImages: readonly MarkdownHtmlRemoteImage[],
  resolve: MarkdownImageResolver | undefined,
  options: { loading: boolean, language: 'zh-CN' | 'en-US' | undefined },
): () => void {
  if (!pendingImages.length && !remoteImages.length)
    return () => {}

  let active = true
  const cancel = () => {
    active = false
  }
  const failedLabel = options.language === 'zh-CN' ? '图片加载失败' : 'Image failed to load'

  function markUnavailable(element: HTMLImageElement, alt: string) {
    if (!element.isConnected)
      return
    const fallback = document.createElement('span')
    fallback.className = 'buddy-markdown-html-img-fallback'
    fallback.setAttribute('role', 'status')
    fallback.textContent = alt.trim() || failedLabel
    element.replaceWith(fallback)
  }

  for (const item of remoteImages) {
    item.element.addEventListener('error', () => {
      if (active)
        markUnavailable(item.element, item.alt)
    }, { once: true })
  }

  if (!pendingImages.length || options.loading)
    return cancel

  if (!resolve) {
    for (const item of pendingImages)
      markUnavailable(item.element, item.alt)
    return cancel
  }

  for (const item of pendingImages) {
    void Promise.resolve(resolve(item.src)).then((result) => {
      if (!active || !item.element.isConnected)
        return
      if (result.kind === 'local') {
        item.element.addEventListener('error', () => {
          if (active)
            markUnavailable(item.element, item.alt)
        }, { once: true })
        item.element.src = result.src
        return
      }
      markUnavailable(item.element, item.alt)
    }).catch(() => {
      if (active)
        markUnavailable(item.element, item.alt)
    })
  }

  return cancel
}
