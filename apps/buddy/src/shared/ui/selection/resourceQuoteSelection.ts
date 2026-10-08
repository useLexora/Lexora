import type { BuddyTextQuote } from '@buddy-shared/conversation/buddyUserContent'

export function readResourceTextSelection(root: HTMLElement, selection: Selection | null, source: BuddyTextQuote['source']): BuddyTextQuote | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer))
    return null
  const excluded = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('button, input, textarea, [contenteditable], [data-quote-exclude]')
  if (excluded(range.startContainer) || excluded(range.endContainer)
    || Array.from(root.querySelectorAll('button, input, textarea, [contenteditable], [data-quote-exclude]')).some(node => range.intersectsNode(node))) {
    return null
  }
  const text = selection.toString()
  if (!text.trim())
    return null
  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  return { id: crypto.randomUUID(), source, text, textOffset: before.toString().length }
}
