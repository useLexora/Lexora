import type {
  DocumentBlockHeadingLevel,
  DocumentBlockIndexEntry,
} from '@haohaoxue/lexora-contracts'

export function resolveActiveOutlineBlockId(
  blockIndex: DocumentBlockIndexEntry[],
  currentBlockId: string | null,
): string | null {
  if (!currentBlockId) {
    return null
  }

  const currentBlockIndex = blockIndex.findIndex(entry => entry.blockId === currentBlockId)

  if (currentBlockIndex < 0) {
    return null
  }

  for (let index = currentBlockIndex; index >= 0; index -= 1) {
    const entry = blockIndex[index]

    if (entry?.headingLevel !== null) {
      return entry.blockId
    }
  }

  return null
}

export function resolveOutlineIndicatorWidth(level: DocumentBlockHeadingLevel): string {
  switch (level) {
    case 1:
      return '18px'
    case 2:
      return '14px'
    case 3:
      return '10px'
    default:
      return '8px'
  }
}

export function resolveOutlineIndent(level: DocumentBlockHeadingLevel): string {
  switch (level) {
    case 1:
      return '0rem'
    case 2:
      return '1rem'
    case 3:
      return '2rem'
    case 4:
      return '3rem'
    default:
      return '4rem'
  }
}

export function resolveOutlineSelectionPosition(targetBlock: {
  from: number
  to: number
}) {
  return Math.max(targetBlock.to - 1, targetBlock.from)
}
