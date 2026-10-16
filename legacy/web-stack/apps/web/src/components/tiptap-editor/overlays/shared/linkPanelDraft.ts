import { preserveExistingLinkHref } from './linkHref'

export interface ExistingLinkDraftInput {
  initialHref: string
  initialText: string
  linkText: string
  linkUrl: string
  normalizedHref: string | null
}

export interface ExistingLinkDraftCommit {
  changed: boolean
  href: string
  text: string
}

export function resolveExistingLinkDraftCommit(input: ExistingLinkDraftInput): ExistingLinkDraftCommit | null {
  const text = input.linkText.trim()
  const href = resolveExistingLinkHrefForCommit(
    input.linkUrl,
    input.initialHref,
    input.normalizedHref,
  )

  if (!text || !href) {
    return null
  }

  return {
    changed: hasExistingLinkDraftChanged(text, href, input.initialText, input.initialHref),
    href,
    text,
  }
}

function resolveExistingLinkHrefForCommit(
  input: string,
  initialHref: string,
  normalizedHref: string | null,
) {
  if (normalizedHref) {
    return normalizedHref
  }

  return input.trim() === initialHref.trim()
    ? preserveExistingLinkHref(initialHref)
    : null
}

function hasExistingLinkDraftChanged(
  text: string,
  href: string,
  initialText: string,
  initialHref: string,
) {
  return text !== initialText.trim()
    || href !== preserveExistingLinkHref(initialHref)
}
