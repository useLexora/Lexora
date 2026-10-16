const HTML_TAG_PATTERN = /<[^>]+>/g

/**
 * 移除 HTML 标签，返回纯文本
 */
export function stripHtmlTags(html: string): string {
  return html.replace(HTML_TAG_PATTERN, '').trim()
}
