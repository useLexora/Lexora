import type { EditorView } from '@tiptap/pm/view'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { normalizeLinkHref } from '../overlays/shared/linkHref'

export const LinkClickOpen = Extension.create({
  name: 'linkClickOpen',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey(this.name),
        props: {
          handleClick: (view, _position, event) => handleLinkClick(view, event),
        },
      }),
    ]
  },
})

function handleLinkClick(view: EditorView, event: MouseEvent) {
  if (event.button !== 0 || event.defaultPrevented) {
    return false
  }

  const linkElement = getLinkElement(event, view.dom)

  if (!linkElement) {
    return false
  }

  const href = normalizeLinkHref(linkElement.getAttribute('href') ?? '')

  event.preventDefault()

  if (!href || typeof window === 'undefined') {
    return true
  }

  window.open(href, linkElement.getAttribute('target') || '_blank', 'noopener,noreferrer')

  return true
}

function getLinkElement(event: MouseEvent, editorElement: HTMLElement) {
  const target = event.target

  if (!(target instanceof Element)) {
    return null
  }

  const linkElement = target.closest<HTMLAnchorElement>('a[href]')

  return linkElement && editorElement.contains(linkElement)
    ? linkElement
    : null
}
