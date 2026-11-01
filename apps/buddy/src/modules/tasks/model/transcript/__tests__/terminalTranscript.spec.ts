import type { DesktopTerminalTranscriptInput } from '../typing'
import { describe, expect, it } from 'vitest'
import { projectDesktopTerminalTranscript, projectDesktopTerminalTranscriptModelUpdate } from '../terminalTranscript'

describe('terminal transcript projection', () => {
  it.each(['cmd', null] as const)('uses %s prompts and syntax without assuming a POSIX shell', (shell) => {
    const projection = projectDesktopTerminalTranscript({ command: 'echo hello', output: 'hello', shell })
    expect(projection).toMatchObject({ language: shell === 'cmd' ? 'bat' : 'plaintext', lineCount: 3, outputStartLine: 3, text: '> echo hello\n\nhello' })
  })

  it('normalizes command/output newlines and locates Bash prompts separately from output', () => {
    expect(projectDesktopTerminalTranscript({ command: 'printf hello\r\nprintf world\r', output: 'hello\r\nworld\r', shell: 'bash' })).toEqual({
      language: 'shell',
      lineCount: 7,
      outputStartLine: 5,
      promptRanges: [{ lineNumber: 1, endColumn: 3 }, { lineNumber: 2, endColumn: 3 }, { lineNumber: 3, endColumn: 3 }],
      text: '$ printf hello\n> printf world\n> \n\nhello\nworld\n',
    })
  })

  it('retains PowerShell continuation prompts and separates empty from whitespace output', () => {
    expect(projectDesktopTerminalTranscript({ command: 'Get-Item .\nSelect-Object Name', output: null, shell: 'powershell' })).toEqual({
      language: 'powershell',
      lineCount: 2,
      outputStartLine: null,
      promptRanges: [{ lineNumber: 1, endColumn: 5 }, { lineNumber: 2, endColumn: 4 }],
      text: 'PS> Get-Item .\n>> Select-Object Name',
    })
    expect(projectDesktopTerminalTranscript({ command: '', output: '', shell: 'bash' }).text).toBe('$ ')
    expect(projectDesktopTerminalTranscript({ command: '', output: ' ', shell: 'bash' }).text).toBe('$ \n\n ')
  })

  it('appends only the new output suffix, including the separator when output first arrives', () => {
    const input: DesktopTerminalTranscriptInput = { command: 'echo hello', output: null, shell: 'bash' }
    const pending = projectDesktopTerminalTranscript(input)
    const first = projectDesktopTerminalTranscript({ ...input, output: 'hel' })
    const next = projectDesktopTerminalTranscript({ ...input, output: 'hello\n' })
    expect(projectDesktopTerminalTranscriptModelUpdate(pending, first)).toEqual({ kind: 'append', text: '\n\nhel' })
    expect(projectDesktopTerminalTranscriptModelUpdate(first, next)).toEqual({ kind: 'append', text: 'lo\n' })
    expect(projectDesktopTerminalTranscriptModelUpdate(next, { ...next })).toEqual({ kind: 'unchanged' })
  })

  it.each([
    { command: 'echo hello', output: 'rewritten output', shell: 'bash' },
    { command: 'echo hello', output: 'h', shell: 'bash' },
    { command: 'echo hello', output: null, shell: 'bash' },
    { command: 'echo hello', output: 'hello', shell: 'powershell' },
  ] satisfies DesktopTerminalTranscriptInput[])('replaces changed commands, shell and non-prefix output: %j', (current) => {
    const previous = projectDesktopTerminalTranscript({ command: 'echo hello', output: 'hello', shell: 'bash' })
    expect(projectDesktopTerminalTranscriptModelUpdate(previous, projectDesktopTerminalTranscript(current))).toEqual({ kind: 'replace' })
  })

  it('does not mistake a longer command with the same prefix for appended output', () => {
    const previous = projectDesktopTerminalTranscript({ command: 'echo', output: null, shell: 'bash' })
    const current = projectDesktopTerminalTranscript({ command: 'echo hello', output: null, shell: 'bash' })
    expect(current.text.startsWith(previous.text)).toBe(true)
    expect(projectDesktopTerminalTranscriptModelUpdate(previous, current)).toEqual({ kind: 'replace' })
  })
})
