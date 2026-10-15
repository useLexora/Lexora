export interface ExplorerNode {
  key: string
  label: string
  kind: 'directory' | 'file'
  children?: readonly ExplorerNode[]
  disabled?: boolean
  changeType?: 'created' | 'modified' | 'deleted'
}

export interface ExplorerRow {
  key: string
  node: ExplorerNode
  parent: string | null
  level: number
  position: number
  siblings: number
}

export function flattenTree(nodes: readonly ExplorerNode[], expanded: ReadonlySet<string>): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const visit = (nodes: readonly ExplorerNode[], level: number, parent: string | null) => {
    nodes.forEach((node, index) => {
      rows.push({ key: node.key, node, parent, level, position: index + 1, siblings: nodes.length })
      if (node.children && expanded.has(node.key))
        visit(node.children, level + 1, node.key)
    })
  }
  visit(nodes, 1, null)
  return rows
}

export function replaceChildren(nodes: readonly ExplorerNode[], key: string, children: readonly ExplorerNode[]): ExplorerNode[] {
  return nodes.map(node => node.key === key ? { ...node, children } : node.children ? { ...node, children: replaceChildren(node.children, key, children) } : node)
}
