import type { ParseOptions } from 'mermaid'
import { desktopMermaidTheme } from '@/theme/mermaidTheme'

function applyDesktopTheme(source: string): string {
  const header = /^%%\{init: \{"theme":"(?:default|dark)","htmlLabels":false,"flowchart":\{"htmlLabels":false\}\}\}%%\n/
  return source.replace(header, () => `%%{init: ${JSON.stringify({ ...desktopMermaidTheme.value, htmlLabels: false, flowchart: { htmlLabels: false } })}}%%\n`)
}

export async function loadDesktopMermaid() {
  const { default: mermaid } = await import('mermaid')
  return {
    initialize: mermaid.initialize,
    parse: (source: string, options?: ParseOptions) => mermaid.parse(applyDesktopTheme(source), options),
    render: (id: string, source: string, container?: Element) => mermaid.render(id, applyDesktopTheme(source), container),
  }
}
