/** Fixed script in a host-created isolated world; never interpolates page content as code. */
export const BROWSER_ELEMENT_PICKER_SCRIPT = String.raw`(() => {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-lexora-element-picker', '');
  Object.assign(overlay.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', display: 'none', border: '2px solid #2563eb', background: 'rgba(37,99,235,.12)', boxSizing: 'border-box' });
  document.documentElement.append(overlay);
  let hovered = null;
  const excluded = 'script, style, noscript, template, input, textarea, select, [contenteditable], [hidden], [aria-hidden="true"]';
  function textOf(element) {
    if (element.closest(excluded)) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = '', count = 0, node;
    while ((node = walker.nextNode())) {
      if (++count > 4096) throw new Error('limit');
      const parent = node.parentElement;
      if (!parent || parent.closest(excluded) || !parent.getClientRects().length) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      text += node.textContent || '';
      if (text.length > 32768) throw new Error('limit');
    }
    return text.trim();
  }
  function selectorOf(element) {
    const parts = [];
    let current = element;
    while (current) {
      const parent = current.parentElement;
      parts.unshift(current.tagName.toLowerCase() + (parent ? ':nth-child(' + (Array.from(parent.children).indexOf(current) + 1) + ')' : ''));
      current = parent;
      if (parts.length > 32) throw new Error('limit');
    }
    return parts.join(' > ');
  }
  function collect(element) {
    const tagName = element.tagName.toLowerCase();
    const name = element.closest('input[type="password"]') ? '' : element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '';
    const role = element.getAttribute('role') || '';
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { text: textOf(element) || name || '<' + tagName + '>', element: {
      tagName, name, role, selector: selectorOf(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontFamily: style.fontFamily }
    } };
  }
  function at(x, y) {
    const element = document.elementFromPoint(x, y);
    return element && !['html', 'body', 'iframe', 'frame'].includes(element.tagName.toLowerCase()) && element !== overlay ? element : null;
  }
  function show(element) {
    hovered = element;
    if (!element) { overlay.style.display = 'none'; return; }
    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  return {
    move(x, y) { show(at(x, y)); },
    pick(x, y) {
      const element = at(x, y);
      if (!element || (hovered && !hovered.isConnected)) return { status: 'unavailable' };
      try { return { status: 'selected', ...collect(element), anchor: { x: x / innerWidth, y: y / innerHeight } }; }
      catch { return { status: 'limit' }; }
    },
    locate(selector, tagName, text) {
      const matches = document.querySelectorAll(selector), element = matches.length === 1 ? matches[0] : null;
      if (!element || element.tagName.toLowerCase() !== tagName || collect(element).text !== text) return false;
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      show(element);
      return true;
    },
    dispose() { overlay.remove(); }
  };
})()`
