import type {
  PublicationInternalLinkResolution,
  PublicationNavItem,
  PublicationSidebarGroup,
  PublicationSidebarPage,
} from '@haohaoxue/lexora-contracts/document/publication'
import type {
  TiptapJsonContent,
  TiptapJsonNode,
} from '@haohaoxue/lexora-contracts/tiptap'
import {
  DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_TYPE,
} from '@haohaoxue/lexora-contracts/document/publication/constants'
import { isExternalPublicationHref, normalizePublicationHref } from '@haohaoxue/lexora-shared/document'
import { translate } from '@/i18n'

export const PUBLICATION_DISABLED_LINK_CLASS = 'publication-link-disabled'

export function getPublicationUnpublishedMessage() {
  return translate('docs.publicReader.unpublishedMessage')
}

export interface ResolvedPublicationNavItem {
  ariaLabel: string
  children: ResolvedPublicationNavItem[]
  disabled: boolean
  external: boolean
  href: string
  icon: string | null
  id: string
  isGroup: boolean
  label: string | null
  openInNewTab: boolean
}

export function rewritePublicationInternalLinks(
  content: TiptapJsonContent,
  internalLinks: PublicationInternalLinkResolution[],
): TiptapJsonContent {
  const internalLinkByDocumentId = new Map(internalLinks.map(link => [link.targetDocumentId, link]))

  return content.map(node => rewritePublicationInternalLinkNode(node, internalLinkByDocumentId))
}

export function resolvePublicationNavItems(input: {
  groups: PublicationSidebarGroup[]
  items: PublicationNavItem[]
  siteId: string
}): ResolvedPublicationNavItem[] {
  const pageById = new Map(collectPublicationSidebarPages(input.groups).map(page => [page.id, page]))
  const firstPageByGroupId = new Map(
    input.groups.flatMap(group => group.pages[0] ? [[group.id, group.pages[0]] as const] : []),
  )
  const resolvedById = new Map<string, ResolvedPublicationNavItem>()
  const topLevelItems: ResolvedPublicationNavItem[] = []

  for (const item of input.items) {
    resolvedById.set(item.id, resolvePublicationNavItem({
      firstPageByGroupId,
      item,
      pageById,
      siteId: input.siteId,
    }))
  }

  for (const item of input.items) {
    const resolvedItem = resolvedById.get(item.id)

    if (!resolvedItem) {
      continue
    }

    const parentId = item.parentId
    const parentItem = parentId ? resolvedById.get(parentId) : null

    if (parentId && !parentItem) {
      continue
    }

    if (parentId) {
      if (parentItem?.isGroup) {
        parentItem.children.push(resolvedItem)
      }

      continue
    }

    topLevelItems.push(resolvedItem)
  }

  return pruneEmptyPublicationNavGroups(topLevelItems)
}

function resolvePublicationNavItem(input: {
  firstPageByGroupId: Map<string, PublicationSidebarPage>
  item: PublicationNavItem
  pageById: Map<string, PublicationSidebarPage>
  siteId: string
}): ResolvedPublicationNavItem {
  const { item } = input

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    return {
      ariaLabel: item.label,
      children: [],
      disabled: false,
      external: false,
      href: '#',
      icon: item.icon,
      id: item.id,
      isGroup: true,
      label: item.label,
      openInNewTab: false,
    }
  }

  const fallbackLabel = resolvePublicationNavItemFallbackLabel(item)

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
    const href = normalizePublicationHref(item.url)

    if (!href) {
      return toResolvedPublicationNavLeaf({
        ariaLabel: resolvePublicationNavItemAriaLabel(item.label, item.icon, fallbackLabel),
        disabled: true,
        external: false,
        href: '#',
        icon: item.icon,
        id: item.id,
        label: item.label,
        openInNewTab: false,
      })
    }

    return toResolvedPublicationNavLeaf({
      ariaLabel: resolvePublicationNavItemAriaLabel(item.label, item.icon, resolveExternalHrefLabel(href)),
      disabled: false,
      external: isExternalPublicationHref(href),
      href,
      icon: item.icon,
      id: item.id,
      label: item.label,
      openInNewTab: isExternalPublicationHref(href) && item.openTarget === DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET.BLANK,
    })
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME) {
    return toResolvedPublicationNavLeaf({
      ariaLabel: resolvePublicationNavItemAriaLabel(item.label, item.icon, fallbackLabel),
      disabled: false,
      external: false,
      href: `/s/${input.siteId}`,
      icon: item.icon,
      id: item.id,
      label: item.label,
      openInNewTab: false,
    })
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.SECTION && item.targetId) {
    const page = input.firstPageByGroupId.get(item.targetId)

    if (page) {
      return toResolvedPublicationNavLeaf({
        ariaLabel: resolvePublicationNavItemAriaLabel(item.label, item.icon, page.title),
        disabled: false,
        external: false,
        href: `/s/${input.siteId}/${page.documentId}`,
        icon: item.icon,
        id: item.id,
        label: item.label,
        openInNewTab: false,
      })
    }
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.PAGE && item.targetId) {
    const page = input.pageById.get(item.targetId)

    if (page) {
      return toResolvedPublicationNavLeaf({
        ariaLabel: resolvePublicationNavItemAriaLabel(item.label, item.icon, page.title),
        disabled: false,
        external: false,
        href: `/s/${input.siteId}/${page.documentId}`,
        icon: item.icon,
        id: item.id,
        label: item.label,
        openInNewTab: false,
      })
    }
  }

  return toResolvedPublicationNavLeaf({
    ariaLabel: resolvePublicationNavItemAriaLabel(item.label, item.icon, fallbackLabel),
    disabled: true,
    external: false,
    href: '#',
    icon: item.icon,
    id: item.id,
    label: item.label,
    openInNewTab: false,
  })
}

function toResolvedPublicationNavLeaf(input: Omit<ResolvedPublicationNavItem, 'children' | 'isGroup'>): ResolvedPublicationNavItem {
  return {
    ...input,
    children: [],
    isGroup: false,
  }
}

function pruneEmptyPublicationNavGroups(items: ResolvedPublicationNavItem[]): ResolvedPublicationNavItem[] {
  return items.flatMap((item) => {
    const children = pruneEmptyPublicationNavGroups(item.children)

    if (item.isGroup) {
      return children.length
        ? [{ ...item, children }]
        : []
    }

    return [{ ...item, children }]
  })
}

function resolvePublicationNavItemFallbackLabel(item: PublicationNavItem): string {
  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL) {
    if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME) {
      return translate('docs.publicationSite.navigation.home')
    }

    if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.SECTION) {
      return translate('docs.publicationSite.navigation.section')
    }

    return translate('docs.publicationSite.navigation.page')
  }

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
    return resolveExternalHrefLabel(item.url)
  }

  return item.label
}

function resolvePublicationNavItemAriaLabel(label: string | null, icon: string | null, fallback: string): string {
  if (label?.trim()) {
    return label
  }

  if (icon?.trim() && !isPublicationNavMediaIconSource(icon)) {
    return icon
  }

  return fallback
}

function isPublicationNavMediaIconSource(icon: string) {
  return icon.startsWith('/') || /^https?:\/\//i.test(icon)
}

function resolveExternalHrefLabel(href: string | null): string {
  const safeHref = normalizePublicationHref(href)

  if (!safeHref) {
    return translate('docs.publicationSite.navigation.externalLink')
  }

  try {
    return new URL(safeHref, window.location.origin).hostname || translate('docs.publicationSite.navigation.externalLink')
  }
  catch {
    return translate('docs.publicationSite.navigation.externalLink')
  }
}

export function collectPublicationSidebarPages(groups: PublicationSidebarGroup[]): PublicationSidebarPage[] {
  return groups.flatMap(group => group.pages.flatMap(page => collectPublicationSidebarPage(page)))
}

function collectPublicationSidebarPage(page: PublicationSidebarPage): PublicationSidebarPage[] {
  return [page, ...page.children.flatMap(child => collectPublicationSidebarPage(child))]
}

function rewritePublicationInternalLinkNode(
  node: TiptapJsonNode,
  internalLinkByDocumentId: ReadonlyMap<string, PublicationInternalLinkResolution>,
): TiptapJsonNode {
  return {
    ...node,
    marks: node.marks?.map((mark) => {
      if (mark.type !== 'link') {
        return mark
      }

      const attrs = mark.attrs ?? {}
      const href = typeof attrs.href === 'string' ? attrs.href : ''
      const targetDocumentId = parseInternalDocumentHref(href)

      if (!targetDocumentId) {
        return mark
      }

      const resolution = internalLinkByDocumentId.get(targetDocumentId)

      if (resolution?.published && resolution.href) {
        return {
          ...mark,
          attrs: {
            ...attrs,
            href: resolution.href,
            class: removeClassName(attrs.class, PUBLICATION_DISABLED_LINK_CLASS),
          },
        }
      }

      return {
        ...mark,
        attrs: {
          ...attrs,
          href: '#',
          class: addClassName(attrs.class, PUBLICATION_DISABLED_LINK_CLASS),
        },
      }
    }),
    content: node.content?.map(child => rewritePublicationInternalLinkNode(child, internalLinkByDocumentId)),
  }
}

function parseInternalDocumentHref(href: string): string | null {
  if (!href.trim()) {
    return null
  }

  try {
    const url = new URL(href, window.location.origin)
    const [prefix, documentId] = url.pathname.split('/').filter(Boolean)

    if ((prefix === 'docs' || prefix === 'p') && documentId) {
      return documentId
    }

    return null
  }
  catch {
    return null
  }
}

function addClassName(value: unknown, className: string): string {
  const classNames = typeof value === 'string'
    ? value.split(/\s+/).filter(Boolean)
    : []

  if (!classNames.includes(className)) {
    classNames.push(className)
  }

  return classNames.join(' ')
}

function removeClassName(value: unknown, className: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const classNames = value.split(/\s+/).filter(item => item && item !== className)
  return classNames.length ? classNames.join(' ') : undefined
}
