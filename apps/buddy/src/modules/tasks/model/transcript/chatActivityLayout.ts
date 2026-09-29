import type { ChatAgentActivityGroup } from './chatAgentActivities'
import type { ChatAgentToolNode } from './chatAgentTurn'
import { getChatToolRegistration, isRegisteredChatTool } from './chatToolRegistry'

interface ChatToolDetailsEntry {
  id: string
  kind: 'tool-details'
  node: ChatAgentToolNode
}

export interface ChatCompactRead {
  position: 'start' | 'continuation'
  target: string
  hasNext: boolean
}

export function presentChatActivityLayout(nodes: ChatAgentActivityGroup['nodes']) {
  const entries: Array<ChatAgentActivityGroup['nodes'][number] | ChatToolDetailsEntry> = []
  const compact = new Map<string, ChatCompactRead>()
  let reads: ChatAgentToolNode[] = []
  let readIcon: string | null = null

  function details(node: ChatAgentToolNode): ChatToolDetailsEntry {
    return { id: `details:${node.id}`, kind: 'tool-details', node }
  }

  function flush() {
    if (reads.length > 1) {
      const paths = reads.map((node) => {
        const path = node.presentation.card === 'read' ? node.presentation.path.replaceAll('\\', '/') : ''
        return readIcon === 'skill' ? path.replace(/\/SKILL\.md$/i, '') : path
      })
      const targets = disambiguatePaths(paths)
      reads.forEach((node, index) => compact.set(node.id, {
        position: index === 0 ? 'start' : 'continuation',
        target: targets.get(paths[index]!)!,
        hasNext: index < reads.length - 1,
      }))
    }
    entries.push(...reads.map(details))
    reads = []
    readIcon = null
  }

  for (const node of nodes) {
    if (node.kind === 'tool' && isRegisteredChatTool(node.toolName) && node.presentation.card === 'read' && node.presentation.path
      && node.status === 'completed' && !node.isError) {
      const icon = getChatToolRegistration(node).icon
      if (readIcon !== icon)
        flush()
      readIcon = icon
      reads.push(node)
      entries.push(node)
    }
    else {
      flush()
      entries.push(node)
      if (node.kind === 'tool')
        entries.push(details(node))
    }
  }
  flush()
  return { entries, compact }
}

function disambiguatePaths(paths: string[]): Map<string, string> {
  const parts = new Map([...new Set(paths)].map(path => [path, path.split('/')]))
  const suffixCounts = new Map<string, number>()
  for (const segments of parts.values()) {
    for (let index = segments.length - 1; index >= 0; index--) {
      const suffix = segments.slice(index).join('/')
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1)
    }
  }
  return new Map([...parts].map(([path, segments]) => {
    for (let index = segments.length - 1; index >= 0; index--) {
      const suffix = segments.slice(index).join('/')
      if (suffixCounts.get(suffix) === 1)
        return [path, suffix]
    }
    return [path, path]
  }))
}
