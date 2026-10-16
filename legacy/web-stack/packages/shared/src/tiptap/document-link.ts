const EXPLICIT_DOCUMENT_LINK_PROTOCOL_PATTERN = /^(?:https?|mailto):/i

export function shouldAutoLinkTiptapDocumentUrl(url: string): boolean {
  return EXPLICIT_DOCUMENT_LINK_PROTOCOL_PATTERN.test(url.trim())
}

export function createTiptapDocumentBodyLinkOptions() {
  return {
    openOnClick: false,
    shouldAutoLink: shouldAutoLinkTiptapDocumentUrl,
  }
}
