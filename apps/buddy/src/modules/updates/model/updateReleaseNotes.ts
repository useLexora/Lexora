export function updateReleaseHighlights(notes: string): string[] {
  const text = notes.slice(0, 8_000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(?:#{1,6}\s|https?:\/\/|[-*_]{3,}$|<)/.test(line))
    .map(line => line.replace(/^(?:[-*+] |\d+\. )/, '').replace(/\*\*|__|`/g, '').slice(0, 400))
    .slice(0, 3)
}
