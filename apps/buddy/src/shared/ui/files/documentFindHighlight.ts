import { scrollQuoteRange } from '@/shared/ui/selection/quoteText'

let sequence = 0

export interface DocumentFindHighlighter {
  show: (ranges: readonly Range[], index: number, scroller: HTMLElement) => void
  clear: () => void
  dispose: () => void
}

// CSS highlights paint over the rendered Markdown without inserting elements, so selection
// offsets used by quote capture stay stable. Names are per instance because the registry is global.
export function createDocumentFindHighlighter(): DocumentFindHighlighter {
  const supported = typeof CSSStyleSheet === 'function'
    && typeof Highlight === 'function'
    && typeof CSS !== 'undefined'
    && typeof CSS.highlights?.set === 'function'
  if (!supported)
    return { show() {}, clear() {}, dispose() {} }
  const matchName = `buddy-document-find-${++sequence}`
  const currentName = `buddy-document-find-current-${sequence}`
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`::highlight(${matchName}) { background-color: var(--buddy-accent-surface); color: inherit; } ::highlight(${currentName}) { background-color: var(--buddy-accent-solid); color: var(--buddy-text-on-accent); }`)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]

  function clear() {
    CSS.highlights.delete(matchName)
    CSS.highlights.delete(currentName)
  }

  function show(ranges: readonly Range[], index: number, scroller: HTMLElement) {
    if (!ranges.length) {
      clear()
      return
    }
    const current = ranges[Math.min(index, ranges.length - 1)]!
    CSS.highlights.set(matchName, new Highlight(...ranges))
    CSS.highlights.set(currentName, new Highlight(current))
    scrollQuoteRange(current, scroller)
  }

  function dispose() {
    clear()
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(item => item !== sheet)
  }

  return { show, clear, dispose }
}
