export type DesktopTerminalShell = import('@buddy-shared/shell/shellProgram').ShellDialect | null

export interface DesktopTerminalTranscriptInput {
  command: string
  output: string | null
  shell: DesktopTerminalShell
}

export interface DesktopTerminalTranscriptProjection {
  language: 'powershell' | 'shell' | 'bat' | 'plaintext'
  lineCount: number
  outputStartLine: number | null
  promptRanges: ReadonlyArray<{
    endColumn: number
    lineNumber: number
  }>
  text: string
}

export type DesktopTerminalTranscriptModelUpdate
  = | { kind: 'unchanged' }
    | { kind: 'replace' }
    | { kind: 'append', text: string }
