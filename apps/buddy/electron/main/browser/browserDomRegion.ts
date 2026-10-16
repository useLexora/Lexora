import type { z } from 'zod'
import type { cdpDomSnapshotSchema } from './browserCdpSchemas'
import type { BrowserDebugger } from './BrowserDebugger'
import { cdpDescribeNodeSchema, cdpQuerySelectorSchema } from './browserCdpSchemas'
import { BrowserHostError } from './BrowserHostError'

type DomSnapshot = z.infer<typeof cdpDomSnapshotSchema>

export async function resolveBrowserRegion(connection: BrowserDebugger, nodeId: number | undefined, selector: string): Promise<number> {
  if (!nodeId)
    throw new BrowserHostError('BROWSER_PAGE_FAILED', 'Browser document is unavailable')
  let response: unknown
  try {
    response = await connection.sendCommand('DOM.querySelector', { nodeId, selector })
  }
  catch {
    throw new BrowserHostError('BROWSER_READ_INVALID_SELECTOR', 'Invalid browser region selector')
  }
  const result = cdpQuerySelectorSchema.parse(response)
  if (!result.nodeId)
    throw new BrowserHostError('BROWSER_TARGET_STALE', 'Browser region was not found')
  const described = cdpDescribeNodeSchema.parse(await connection.sendCommand('DOM.describeNode', { nodeId: result.nodeId, depth: 0 }))
  return described.node.backendNodeId
}

export function collectBrowserRegionNodes(snapshot: DomSnapshot, frameId: string, backendNodeId: number): Set<number> {
  const document = snapshot.documents.find(document => snapshot.strings[document.frameId] === frameId)
  if (!document?.nodes.parentIndex)
    throw new BrowserHostError('BROWSER_PAGE_FAILED', 'Browser document hierarchy is unavailable')
  const root = document.nodes.backendNodeId.indexOf(backendNodeId)
  if (root < 0)
    throw new BrowserHostError('BROWSER_TARGET_STALE', 'Browser region changed during observation')
  const included = new Set<number>()
  const indices = new Set<number>([root])
  for (let index = root; index < document.nodes.backendNodeId.length; index++) {
    if (index === root || indices.has(document.nodes.parentIndex[index])) {
      indices.add(index)
      included.add(document.nodes.backendNodeId[index])
    }
  }
  return included
}
