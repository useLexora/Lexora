import type { DesktopTerminalTranscriptInput, DesktopTerminalTranscriptModelUpdate, DesktopTerminalTranscriptProjection } from './typing'

export function projectDesktopTerminalTranscript(input: DesktopTerminalTranscriptInput): DesktopTerminalTranscriptProjection {
  const commandLines = normalizeLineEndings(input.command).split('\n')
  const firstPrompt = input.shell === 'powershell' ? 'PS> ' : input.shell === 'cmd' || input.shell === null ? '> ' : '$ '
  const continuationPrompt = input.shell === 'powershell' ? '>> ' : '> '
  const promptedCommand = commandLines.map((line, index) => (
    `${index === 0 ? firstPrompt : continuationPrompt}${line}`
  ))
  const normalizedOutput = input.output ? normalizeLineEndings(input.output) : null
  const outputStartLine = normalizedOutput === null ? null : promptedCommand.length + 2
  const text = normalizedOutput === null
    ? promptedCommand.join('\n')
    : `${promptedCommand.join('\n')}\n\n${normalizedOutput}`
  return {
    language: input.shell === 'powershell' ? 'powershell' : input.shell === 'cmd' ? 'bat' : input.shell === null ? 'plaintext' : 'shell',
    lineCount: text.split('\n').length,
    outputStartLine,
    promptRanges: commandLines.map((_, index) => ({
      endColumn: (index === 0 ? firstPrompt : continuationPrompt).length + 1,
      lineNumber: index + 1,
    })),
    text,
  }
}

export function projectDesktopTerminalTranscriptModelUpdate(
  previous: DesktopTerminalTranscriptProjection,
  current: DesktopTerminalTranscriptProjection,
): DesktopTerminalTranscriptModelUpdate {
  const commandChanged = !hasSameTerminalCommand(previous, current)
  if (
    !commandChanged
    && previous.text === current.text
    && previous.outputStartLine === current.outputStartLine
  ) {
    return { kind: 'unchanged' }
  }
  if (!commandChanged && current.text.startsWith(previous.text)) {
    return {
      kind: 'append',
      text: current.text.slice(previous.text.length),
    }
  }
  return { kind: 'replace' }
}

function hasSameTerminalCommand(
  previous: DesktopTerminalTranscriptProjection,
  current: DesktopTerminalTranscriptProjection,
): boolean {
  if (
    previous.language !== current.language
    || previous.promptRanges.length !== current.promptRanges.length
  ) {
    return false
  }
  const commandLineCount = previous.promptRanges.length
  return previous.text.split('\n', commandLineCount).join('\n')
    === current.text.split('\n', commandLineCount).join('\n')
    && previous.promptRanges.every((range, index) => {
      const currentRange = current.promptRanges[index]
      return currentRange !== undefined
        && range.lineNumber === currentRange.lineNumber
        && range.endColumn === currentRange.endColumn
    })
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}
