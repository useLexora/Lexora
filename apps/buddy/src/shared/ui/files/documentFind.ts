export const documentFindLimit = 999

const excludedSelector = 'button, input, textarea, [aria-hidden="true"], [hidden]'
const blockTags = /^(?:ADDRESS|ARTICLE|BLOCKQUOTE|DIV|H1|H2|H3|H4|H5|H6|LI|OL|P|PRE|SECTION|TABLE|TR|UL)$/

interface TextSpan {
  node: Text
  start: number
}

export interface DocumentFindRanges {
  ranges: Range[]
  capped: boolean
}

// Preview search reads the rendered text, not the Markdown source. Block boundaries become
// newlines so a match cannot jump from the end of one paragraph to the start of the next,
// while inline markup such as <strong> still matches as one phrase.
export function documentFindRanges(root: HTMLElement, query: string, limit = documentFindLimit): DocumentFindRanges {
  const needle = query.trim()
  if (!needle)
    return { ranges: [], capped: false }
  const { text, spans } = indexVisibleText(root)
  const { starts, capped } = findDocumentMatches(text, needle, limit)
  const ranges = starts.flatMap((start) => {
    const range = rangeFor(spans, start, start + needleLength(text, needle))
    return range ? [range] : []
  })
  return { ranges, capped }
}

export function findDocumentMatches(text: string, query: string, limit = documentFindLimit): { starts: number[], capped: boolean } {
  const needle = query.trim()
  if (!needle)
    return { starts: [], capped: false }
  const foldedNeedle = needle.toLowerCase()
  const foldedText = text.toLowerCase()
  const source = foldedNeedle.length === needle.length && foldedText.length === text.length
    ? { text: foldedText, needle: foldedNeedle }
    : { text, needle }
  const starts: number[] = []
  let from = 0
  while (starts.length <= limit) {
    const index = source.text.indexOf(source.needle, from)
    if (index < 0)
      break
    starts.push(index)
    from = index + Math.max(source.needle.length, 1)
  }
  const capped = starts.length > limit
  if (capped)
    starts.length = limit
  return { starts, capped }
}

export function handleDocumentFindKey(event: KeyboardEvent, find: {
  open: boolean
  searchable: boolean
  show: () => void
  close: () => void
  next: () => void
  previous: () => void
}): void {
  if (event.isComposing || event.altKey)
    return
  const command = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  if (command && key === 'f' && !event.shiftKey && find.searchable) {
    event.preventDefault()
    event.stopPropagation()
    find.show()
    return
  }
  if (!find.open)
    return
  if (key === 'escape') {
    event.preventDefault()
    find.close()
    return
  }
  if (key === 'f3' || (command && key === 'g')) {
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey)
      find.previous()
    else
      find.next()
  }
}

function needleLength(text: string, needle: string): number {
  const foldedNeedle = needle.toLowerCase()
  const foldedText = text.toLowerCase()
  return foldedNeedle.length === needle.length && foldedText.length === text.length ? foldedNeedle.length : needle.length
}

function indexVisibleText(root: HTMLElement): { text: string, spans: TextSpan[] } {
  const spans: TextSpan[] = []
  let text = ''
  function walk(node: Node, leadingBoundary: boolean) {
    if (leadingBoundary)
      text += '\n'
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement
      if (!parent || parent.closest(excludedSelector))
        return
      const value = node.nodeValue ?? ''
      if (!value)
        return
      spans.push({ node: node as Text, start: text.length })
      text += value
      return
    }
    if (!(node instanceof HTMLElement) || (node !== root && node.closest(excludedSelector)))
      return
    let boundary = false
    for (const child of node.childNodes) {
      const blocked = child instanceof HTMLElement && blockTags.test(child.tagName)
      walk(child, boundary && blocked)
      boundary = true
    }
  }
  walk(root, false)
  return { text, spans }
}

function rangeFor(spans: readonly TextSpan[], start: number, end: number): Range | null {
  const from = position(spans, start, false)
  const to = position(spans, end, true)
  if (!from || !to)
    return null
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

function position(spans: readonly TextSpan[], offset: number, end: boolean): { node: Text, offset: number } | null {
  for (const span of spans) {
    const spanEnd = span.start + span.node.length
    if (offset < span.start || offset > spanEnd)
      continue
    if (!end && offset === spanEnd)
      continue
    return { node: span.node, offset: offset - span.start }
  }
  return null
}
