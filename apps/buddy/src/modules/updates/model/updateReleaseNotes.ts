const conventionalCommitPrefix = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:\s*/i

function cleanReleaseHighlight(line: string): string {
  return line
    .replace(/^(?:[-*+] |\d+\. )/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+by\s+@?[\w-]+\s+in\s+(?:https?:\/\/\S+|#\d+)\s*$/i, '')
    .replace(/\s+\(#\d+\)\s*$/, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^Full Changelog:\s*/i, '')
    .replace(conventionalCommitPrefix, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

export function updateReleaseHighlights(notes: string): string[] {
  const text = notes.slice(0, 8_000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  const highlights = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(?:#{1,6}\s|https?:\/\/|[-*_]{3,}$|<)/.test(line))
    .map(cleanReleaseHighlight)
    .filter(Boolean)

  return [...new Set(highlights)].slice(0, 3)
}
