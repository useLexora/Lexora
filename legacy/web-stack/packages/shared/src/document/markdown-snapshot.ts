import type { TiptapJsonContent, TiptapJsonNode } from '@haohaoxue/lexora-contracts'

export function serializeTiptapJsonContentToMarkdownLike(content: TiptapJsonContent): string {
  return content
    .map(node => serializeBlock(node, { listDepth: 0, orderedIndex: 1 }))
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

interface SerializeContext {
  listDepth: number
  orderedIndex: number
}

function serializeBlock(node: TiptapJsonNode, context: SerializeContext): string {
  switch (node.type) {
    case 'paragraph':
      return serializeInlineContent(node.content)
    case 'heading':
      return serializeHeading(node)
    case 'blockquote':
      return serializeBlockquote(node, context)
    case 'bulletList':
      return serializeList(node, { ...context, orderedIndex: 1 }, 'bullet')
    case 'orderedList':
      return serializeList(node, { ...context, orderedIndex: readNumber(node.attrs?.start, 1) }, 'ordered')
    case 'taskList':
      return serializeList(node, { ...context, orderedIndex: 1 }, 'task')
    case 'listItem':
      return serializeListItem(node, context, 'bullet')
    case 'taskItem':
      return serializeListItem(node, context, 'task')
    case 'codeBlock':
      return serializeCodeBlock(node)
    case 'table':
      return serializeTable(node)
    case 'horizontalRule':
      return '---'
    case 'blockMath':
      return serializeBlockMath(node)
    case 'image':
    case 'file':
      return ''
    default:
      return serializeUnknownBlock(node, context)
  }
}

function serializeHeading(node: TiptapJsonNode): string {
  const level = Math.min(Math.max(readNumber(node.attrs?.level, 1), 1), 6)
  const text = serializeInlineContent(node.content)
  return `${'#'.repeat(level)} ${text}`.trimEnd()
}

function serializeBlockquote(node: TiptapJsonNode, context: SerializeContext): string {
  const content = serializeChildBlocks(node.content, context)
  return content
    .split('\n')
    .map(line => line ? `> ${line}` : '>')
    .join('\n')
}

function serializeList(
  node: TiptapJsonNode,
  context: SerializeContext,
  kind: 'bullet' | 'ordered' | 'task',
): string {
  return (node.content ?? [])
    .map((item, index) => serializeListItem(item, {
      ...context,
      orderedIndex: context.orderedIndex + index,
    }, kind))
    .filter(Boolean)
    .join('\n')
}

function serializeListItem(
  node: TiptapJsonNode,
  context: SerializeContext,
  kind: 'bullet' | 'ordered' | 'task',
): string {
  const indent = '  '.repeat(context.listDepth)
  const marker = kind === 'ordered'
    ? `${context.orderedIndex}. `
    : kind === 'task'
      ? `- [${node.attrs?.checked === true ? 'x' : ' '}] `
      : '- '
  const childBlocks = node.content ?? []
  const firstText = serializeListItemPrimaryText(childBlocks)
  const nested = childBlocks
    .filter(child => child.type !== 'paragraph')
    .map(child => serializeBlock(child, {
      ...context,
      listDepth: context.listDepth + 1,
      orderedIndex: 1,
    }))
    .filter(Boolean)
    .map(text => text.split('\n').map(line => `  ${line}`).join('\n'))
    .join('\n')
  const firstLine = `${indent}${marker}${firstText}`.trimEnd()

  return [firstLine, nested].filter(Boolean).join('\n')
}

function serializeListItemPrimaryText(nodes: TiptapJsonNode[]): string {
  const paragraph = nodes.find(node => node.type === 'paragraph')
  if (paragraph) {
    return serializeInlineContent(paragraph.content)
  }

  return nodes
    .filter(node => node.type !== 'bulletList' && node.type !== 'orderedList' && node.type !== 'taskList')
    .map(node => serializeBlock(node, { listDepth: 0, orderedIndex: 1 }))
    .filter(Boolean)
    .join(' ')
}

function serializeCodeBlock(node: TiptapJsonNode): string {
  const language = readString(node.attrs?.language)
  const text = serializePlainText(node.content)
  return [`\`\`\`${language}`, text, '```'].join('\n')
}

function serializeTable(node: TiptapJsonNode): string {
  const rows = (node.content ?? [])
    .filter(row => row.type === 'tableRow')
    .map(row => (row.content ?? [])
      .filter(cell => cell.type === 'tableCell' || cell.type === 'tableHeader')
      .map(cell => escapeTableCell(serializeChildBlocks(cell.content, { listDepth: 0, orderedIndex: 1 }).replace(/\n+/g, ' ').trim())))
    .filter(row => row.length > 0)

  if (!rows.length) {
    return ''
  }

  const columnCount = Math.max(...rows.map(row => row.length))
  const normalizedRows = rows.map(row => Array.from({ length: columnCount }, (_, index) => row[index] ?? ''))
  const header = normalizedRows[0] ?? []
  const separator = header.map(() => '---')

  return [header, separator, ...normalizedRows.slice(1)]
    .map(row => `| ${row.join(' | ')} |`)
    .join('\n')
}

function serializeBlockMath(node: TiptapJsonNode): string {
  const latex = readString(node.attrs?.latex)
  return ['$$', latex, '$$'].join('\n')
}

function serializeUnknownBlock(node: TiptapJsonNode, context: SerializeContext): string {
  if (!node.content?.length) {
    return ''
  }

  return serializeChildBlocks(node.content, context)
}

function serializeChildBlocks(content: TiptapJsonNode[] | undefined, context: SerializeContext): string {
  return (content ?? [])
    .map(child => serializeBlock(child, context))
    .filter(Boolean)
    .join('\n\n')
}

function serializeInlineContent(content: TiptapJsonNode[] | undefined): string {
  return (content ?? []).map(serializeInlineNode).join('')
}

function serializeInlineNode(node: TiptapJsonNode): string {
  switch (node.type) {
    case 'text':
      return applyTextMarks(node.text ?? '', node.marks)
    case 'hardBreak':
      return '\n'
    case 'inlineMath':
      return `$${readString(node.attrs?.latex)}$`
    case 'image':
    case 'file':
      return ''
    default:
      return serializeInlineContent(node.content)
  }
}

function serializePlainText(content: TiptapJsonNode[] | undefined): string {
  return (content ?? []).map((node) => {
    if (node.type === 'text') {
      return node.text ?? ''
    }
    if (node.type === 'hardBreak') {
      return '\n'
    }
    return serializePlainText(node.content)
  }).join('')
}

function applyTextMarks(text: string, marks: TiptapJsonNode['marks']): string {
  return (marks ?? []).reduce((current, mark) => {
    switch (mark.type) {
      case 'bold':
      case 'strong':
        return `**${current}**`
      case 'italic':
      case 'em':
        return `*${current}*`
      case 'strike':
        return `~~${current}~~`
      case 'code':
        return `\`${current}\``
      case 'link':
        return serializeLink(current, mark.attrs)
      default:
        return current
    }
  }, text)
}

function serializeLink(text: string, attrs: Record<string, unknown> | undefined): string {
  const href = readString(attrs?.href)
  return href ? `[${text}](${href})` : text
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
