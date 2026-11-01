import type { FindToolDetails, FindToolInput, GrepToolDetails, GrepToolInput, LsToolDetails, LsToolInput } from '@earendil-works/pi-coding-agent'
import type { WslPath } from '../../../shared/files/wslPath'
import type { RunWslSearch } from './wslProcess'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from '@earendil-works/pi-coding-agent'
import { parseWslPath } from '../../../shared/files/wslPath'
import { runWslSearch, WslProgramError } from './wslProcess'

// Searches of a WSL directory run inside the distribution: over \\wsl.localhost every file visited is a round trip to the
// Linux side, so a repository-wide search takes tens of seconds and a Linux process finishes it in well under a second.
// Output shapes and limits match the built-in grep, find and ls tools so the model sees the same results either way.

const GREP_MAX_LINE_LENGTH = 500
const NEWLINE = 10
const NUL = 0
const OPEN_BRACE = 0x7B

export interface SearchResult<TDetails> {
  content: { type: 'text', text: string }[]
  details: TDetails | undefined
}

// The WSL location a search targets, or null when the built-in Windows implementation should handle it.
// A Linux path such as /home/... is never taken as WSL here: the file tools reject it before they run.
export function resolveWslPath(inputPath: string | undefined, cwd: string): WslPath | null {
  const value = inputPath ? inputPath.replace(/^@/, '') : '.'
  const absolute = parseWslPath(value)
  if (absolute)
    return { distribution: absolute.distribution, linuxPath: posix.normalize(absolute.linuxPath) }
  const base = parseWslPath(cwd)
  if (!base || /^[/\\~]/.test(value) || /^[a-z]:/i.test(value))
    return null
  return { distribution: base.distribution, linuxPath: posix.resolve(base.linuxPath, value.replaceAll('\\', '/')) }
}

export function wslUncPath({ distribution, linuxPath }: WslPath): string {
  return `\\\\wsl.localhost\\${distribution}${linuxPath.replaceAll('/', '\\')}`
}

function searchLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined)
    return fallback
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Search limits must be non-negative integers')
  return Math.min(Math.max(1, value), maximum)
}

function eventText(value: { text?: unknown, bytes?: unknown } | undefined): string {
  if (typeof value?.text === 'string')
    return value.text
  if (typeof value?.bytes === 'string')
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.bytes, 'base64'))
  throw new Error('Invalid ripgrep text record')
}

function withPathNotFound(target: WslPath, error: unknown): unknown {
  return error instanceof Error && /No such file or directory/.test(error.message) ? new Error(`Path not found: ${wslUncPath(target)}`) : error
}

export async function executeWslGrep(target: WslPath, input: GrepToolInput, signal: AbortSignal | undefined, run: RunWslSearch = runWslSearch): Promise<SearchResult<GrepToolDetails>> {
  signal?.throwIfAborted()
  const limit = searchLimit(input.limit, 100, 10_000)
  const context = input.context === undefined || input.context === 0 ? 0 : searchLimit(input.context, 0, 100)
  const args = ['--json', '--no-config', '--line-number', '--color=never', '--hidden']
  if (input.ignoreCase)
    args.push('--ignore-case')
  if (input.literal)
    args.push('--fixed-strings')
  if (input.glob)
    args.push('--glob', input.glob)
  if (context)
    args.push('--context', String(context))
  // Excluded last so that a whitelist glob cannot bring .git (whose pr-worktrees hold full source copies) back in.
  args.push('--glob', '!.git', '--', input.pattern, target.linuxPath)
  const lines: string[] = []
  let bytes = 0
  let matches = 0
  let remainingContext = context
  let clipped = false
  let budgetReached = false
  try {
    await run({
      distribution: target.distribution,
      program: 'rg',
      args,
      signal,
      separator: NEWLINE,
      successCodes: [0, 1],
      onRecord(record) {
        // Every rg record is a JSON object; anything else is wsl.exe itself failing, in the language of the system.
        if (record[0] !== OPEN_BRACE)
          throw new Error(`wsl.exe failed: ${record.toString('utf8').trim()}`)
        const event = JSON.parse(record.toString('utf8'))
        if (event.type === 'end' && matches >= limit)
          return false
        if (event.type !== 'match' && event.type !== 'context')
          return
        const isMatch = event.type === 'match'
        if (isMatch && matches >= limit)
          return false
        const file = eventText(event.data?.path)
        const number = event.data?.line_number
        if (!Number.isSafeInteger(number) || number < 1)
          throw new Error('Invalid ripgrep line number')
        const shown = file === target.linuxPath ? posix.basename(file) : posix.relative(target.linuxPath, file)
        const value = eventText(event.data?.lines).replace(/\r?\n$/, '')
        const { text, wasTruncated } = truncateLine(value)
        clipped ||= wasTruncated
        const line = isMatch ? `${shown}:${number}: ${text}` : `${shown}-${number}- ${text}`
        bytes += Buffer.byteLength(line) + 1
        if (bytes > DEFAULT_MAX_BYTES - 1024) {
          budgetReached = true
          return false
        }
        lines.push(line)
        if (isMatch)
          matches++
        if (matches >= limit) {
          if (!context)
            return false
          if (!isMatch && --remainingContext <= 0)
            return false
        }
      },
    })
  }
  catch (error) {
    throw withPathNotFound(target, error)
  }
  const details: GrepToolDetails = {}
  const notices: string[] = []
  if (matches >= limit) {
    details.matchLimitReached = limit
    notices.push(`${limit} matches limit reached; narrow the path or pattern`)
  }
  if (clipped) {
    details.linesTruncated = true
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars`)
  }
  const output = lines.join('\n')
  if (budgetReached) {
    details.truncation = { ...truncateHead(output), truncated: true, truncatedBy: 'bytes' }
    notices.push('Search output budget reached; narrow the path or pattern')
  }
  return {
    content: [{ type: 'text', text: (output || (budgetReached ? 'Search output omitted' : 'No matches found')) + (notices.length ? `\n\n[${notices.join('. ')}]` : '') }],
    details: Object.keys(details).length ? details : undefined,
  }
}

// ripgrep lists files, not directories, and the distribution needs no fd: a find pattern matches file names and paths only.
export async function executeWslFind(target: WslPath, input: FindToolInput, signal: AbortSignal | undefined, run: RunWslSearch = runWslSearch): Promise<SearchResult<FindToolDetails>> {
  signal?.throwIfAborted()
  const limit = searchLimit(input.limit, 1000, 10_000)
  let pattern = input.pattern
  if (pattern.includes('/') && !pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**')
    pattern = `**/${pattern}`
  const lines: string[] = []
  let count = 0
  let bytes = 0
  let budgetReached = false
  try {
    await run({
      distribution: target.distribution,
      program: 'rg',
      args: ['--files', '--hidden', '--no-config', '--color=never', '--null', '--glob', pattern, '--glob', '!.git', '--', target.linuxPath],
      signal,
      separator: NUL,
      successCodes: [0, 1],
      onRecord(record) {
        count++
        if (count > limit)
          return false
        const file = new TextDecoder('utf-8', { fatal: true }).decode(record)
        const line = posix.relative(target.linuxPath, file) || posix.basename(file)
        bytes += Buffer.byteLength(line) + 1
        if (bytes > DEFAULT_MAX_BYTES - 1024) {
          budgetReached = true
          return false
        }
        lines.push(line)
      },
    })
  }
  catch (error) {
    throw withPathNotFound(target, error)
  }
  const output = lines.join('\n')
  const details: FindToolDetails = {}
  const notices: string[] = []
  if (count > limit) {
    details.resultLimitReached = limit
    notices.push(`${limit} results limit reached; narrow the path or pattern`)
  }
  if (budgetReached) {
    details.truncation = { ...truncateHead(output), truncated: true, truncatedBy: 'bytes' }
    notices.push('Search output budget reached; narrow the path or pattern')
  }
  return {
    content: [{ type: 'text', text: (output || (budgetReached ? 'Search output omitted' : 'No files found matching pattern')) + (notices.length ? `\n\n[${notices.join('. ')}]` : '') }],
    details: Object.keys(details).length ? details : undefined,
  }
}

export async function executeWslLs(target: WslPath, input: LsToolInput, signal: AbortSignal | undefined, run: RunWslSearch = runWslSearch): Promise<SearchResult<LsToolDetails>> {
  signal?.throwIfAborted()
  const limit = input.limit ?? 500
  // Each record is the depth (0 for the directory itself, 1 for an entry), the type after following symlinks, then the name.
  let rootType: string | undefined
  const entries: { name: string, directory: boolean }[] = []
  try {
    await run({
      distribution: target.distribution,
      program: 'find',
      args: ['-H', target.linuxPath, '-maxdepth', '1', '-printf', String.raw`%d%Y%f\0`],
      signal,
      separator: NUL,
      successCodes: [0],
      onRecord(record) {
        const depth = record[0]
        const type = String.fromCharCode(record[1]!)
        if (depth === 0x30) {
          rootType = type
          return
        }
        // Broken links, loops and unreadable entries are skipped, as when stat fails in the built-in tool.
        if (type === 'd' || type === 'f' || type === 'l' || type === 'p' || type === 's' || type === 'b' || type === 'c')
          entries.push({ name: new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(2)), directory: type === 'd' })
      },
    })
  }
  catch (error) {
    // find exits with 1 when it cannot read something; any other code is wsl.exe itself failing (an unknown distribution).
    // find prints the directory itself first, so no record at all means it does not exist.
    if (!(error instanceof WslProgramError) || error.exitCode !== 1)
      throw error
    throw new Error(rootType === undefined ? `Path not found: ${wslUncPath(target)}` : `Cannot read directory: ${error.message}`)
  }
  if (rootType !== 'd')
    throw new Error(`Not a directory: ${wslUncPath(target)}`)
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  const results: string[] = []
  let entryLimitReached = false
  for (const entry of entries) {
    if (results.length >= limit) {
      entryLimitReached = true
      break
    }
    results.push(entry.directory ? `${entry.name}/` : entry.name)
  }
  if (results.length === 0)
    return { content: [{ type: 'text', text: '(empty directory)' }], details: undefined }
  const truncation = truncateHead(results.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
  let output = truncation.content
  const details: LsToolDetails = {}
  const notices: string[] = []
  if (entryLimitReached) {
    notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`)
    details.entryLimitReached = limit
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
    details.truncation = truncation
  }
  if (notices.length > 0)
    output += `\n\n[${notices.join('. ')}]`
  return { content: [{ type: 'text', text: output }], details: Object.keys(details).length > 0 ? details : undefined }
}
