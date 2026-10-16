export const BROWSER_ELEMENT_PICKER_SCROLL_BINDING = '__lexoraElementPickerScrolled'

export const BROWSER_ELEMENT_PICKER_SCROLL_SCRIPT = String.raw`function(bindingName, requestId) {
  globalThis.__lexoraElementPickerScroll?.dispose();
  let frame;
  function changed() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      globalThis[bindingName](requestId);
    });
  }
  function dispose() {
    cancelAnimationFrame(frame);
    removeEventListener('scroll', changed, true);
    removeEventListener('resize', changed);
    delete globalThis.__lexoraElementPickerScroll;
  }
  addEventListener('scroll', changed, true);
  addEventListener('resize', changed);
  globalThis.__lexoraElementPickerScroll = { dispose };
}`

export const BROWSER_ELEMENT_PICKER_SCROLL_CLEAR_SCRIPT = 'globalThis.__lexoraElementPickerScroll?.dispose()'

export const BROWSER_ELEMENT_SNAPSHOT_SCRIPT = String.raw`function() {
  const element = this;
  if (!(element instanceof Element) || !element.isConnected || ['html', 'body', 'iframe', 'frame'].includes(element.localName))
    throw new Error('Element unavailable');
  const excluded = 'script, style, noscript, template, input, textarea, select, [contenteditable], [hidden], [aria-hidden="true"]';
  function textOf(element) {
    if (element.closest(excluded)) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = '', count = 0, node;
    while ((node = walker.nextNode())) {
      if (++count > 4096) throw new Error('Selection limit');
      const parent = node.parentElement;
      if (!parent || parent.closest(excluded) || !parent.getClientRects().length) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      text += node.textContent || '';
      if (text.length > 32768) break;
    }
    return text.trim();
  }
  function selectorOf(element) {
    const parts = [];
    let current = element;
    while (current) {
      if (current.id) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }
      const parent = current.parentElement;
      parts.unshift(current.localName + (parent ? ':nth-child(' + (Array.from(parent.children).indexOf(current) + 1) + ')' : ''));
      current = parent;
      if (parts.length >= 32) break;
    }
    return parts.join(' > ');
  }
  const tagName = element.localName;
  const name = element.closest('input[type="password"]') ? '' : element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '';
  const role = element.getAttribute('role') || '';
  const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
  const attributes = {};
  for (const key of ['id', 'class', 'data-testid', 'data-test', 'data-qa', 'type']) {
    if (element.hasAttribute(key)) attributes[key] = element.getAttribute(key);
  }
  return { status: 'selected', text: textOf(element) || name || '<' + tagName + '>', element: {
    tagName, name, role, selector: selectorOf(element), attributes,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    style: { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontFamily: style.fontFamily,
      display: style.display, position: style.position, gap: style.gap, padding: style.padding, margin: style.margin, borderRadius: style.borderRadius }
  } };
}`
