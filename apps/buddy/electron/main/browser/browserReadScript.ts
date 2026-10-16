export const BROWSER_READ_FUNCTION = String.raw`function (mode, selector) {
  const document = this.nodeType === 9 ? this : this.ownerDocument
  const view = document.defaultView
  let root = this
  if (selector) {
    try { root = this.querySelector(selector) }
    catch { return { error: 'invalid-selector' } }
  } else if (this.nodeType === 9) {
    root = mode === 'text' ? document.querySelector('article') || document.querySelector('main') || document.body : document.body
  }
  if (!root || !root.isConnected) return { error: 'missing-region' }
  const blocked = 'script,style,noscript,template,input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"],[aria-hidden="true"],[hidden]'
  function visible(element) {
    if (!element || element.closest(blocked)) return false
    const style = view.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && (style.display === 'contents' || element.getClientRects().length > 0)
  }
  const items = []
  let sourceTruncated = false, characters = 0, visited = 0
  const result = () => ({ items, sourceTruncated, url: document.URL })
  if (root.nodeType === 1 && !visible(root)) return result()
  function bounded(value, max) {
    const text = value.replace(/\s+/g, ' ').trim()
    if (text.length > max) sourceTruncated = true
    return text.slice(0, max)
  }
  function add(item) {
    const size = JSON.stringify(item).length
    if (items.length >= 2000 || characters + size > 262144) { sourceTruncated = true; return false }
    characters += size
    items.push(item)
    return true
  }
  function textOf(element, max) {
    const walker = document.createTreeWalker(element, 4)
    let node, text = ''
    while ((node = walker.nextNode())) {
      if (++visited > 20000) { sourceTruncated = true; break }
      if (visible(node.parentElement)) {
        const raw = node.textContent
        if (raw.length > max - text.length) sourceTruncated = true
        text += raw.slice(0, Math.max(0, max - text.length)) + ' '
      }
      if (text.trim().length > max) { sourceTruncated = true; break }
    }
    return bounded(text, max)
  }
  if (mode === 'text') {
    const walker = document.createTreeWalker(root, 4)
    let node = root.nodeType === 3 ? root : walker.nextNode()
    while (node) {
      if (++visited > 20000) { sourceTruncated = true; break }
      if (!visible(node.parentElement)) { node = walker.nextNode(); continue }
      const raw = node.textContent
      if (raw.length > 262144 - characters) sourceTruncated = true
      const text = raw.slice(0, Math.max(0, 262144 - characters)).replace(/\s+/g, ' ').trim()
      for (let index = 0; index < text.length; index += 2048) {
        if (!add({ kind: 'text', text: text.slice(index, index + 2048) })) return result()
      }
      node = walker.nextNode()
    }
  } else if (mode === 'links') {
    const links = root.matches?.('a[href]') ? [root] : root.querySelectorAll?.('a[href]') || []
    for (const link of links) {
      if (++visited > 20000) { sourceTruncated = true; break }
      if (!visible(link)) continue
      const url = link.href
      if (!/^https?:/i.test(url)) continue
      if (url.length > 4096) { sourceTruncated = true; continue }
      if (!add({ kind: 'link', text: textOf(link, 1024), url })) break
    }
  } else {
    const tables = root.matches?.('table') ? [root] : root.querySelectorAll?.('table') || []
    let tableIndex = 0
    for (const table of tables) {
      if (++visited > 20000) { sourceTruncated = true; break }
      if (!visible(table)) continue
      const caption = table.caption ? textOf(table.caption, 512) : ''
      for (const row of table.rows) {
        if (++visited > 20000) { sourceTruncated = true; return result() }
        if (!visible(row)) continue
        if (row.cells.length > 32) sourceTruncated = true
        const cells = Array.from(row.cells).slice(0, 32).map(cell => textOf(cell, 128))
        if (!add({ kind: 'table-row', caption, cells, rowIndex: row.rowIndex, tableIndex })) return result()
      }
      tableIndex++
    }
  }
  return result()
}`
