import type { ShellCommandClassification } from '../shellCommandClassification'
import { MAX_TARGET_PATHS } from '../../../../../shared/permissions/approvalReviewPayload'
import { OPERATING_SYSTEM } from '../../../../../shared/platform/identifiers'
import { classifyGitCommand } from '../gitCommandRules'
import { requireShellApproval } from '../shellCommandClassification'

type CommandValidator = (arguments_: readonly string[]) => boolean

const allowedEnvironment = new Map<string, RegExp>([
  ['COLUMNS', /^\d{1,4}$/],
  ['LANG', /^(?:C|POSIX)$/],
  ['LC_ALL', /^(?:C|POSIX)$/],
  ['LINES', /^\d{1,4}$/],
  ['TZ', /^(?:UTC|Etc\/UTC)$/],
])

const commonCommandValidators = new Map<string, CommandValidator>([
  ['awk', validateAwk],
  ['df', validateDf],
  ['echo', allowLiteralArguments],
  ['grep', validateGrep],
  ['head', validateHead],
  ['hostname', validateHostname],
  ['id', allowLiteralArguments],
  ['pgrep', validatePgrep],
  ['printf', validatePrintf],
  ['ps', allowLiteralArguments],
  ['pwd', allowLiteralArguments],
  ['rg', validateRg],
  ['sort', validateSort],
  ['tail', validateTail],
  ['tr', validateTr],
  ['uname', allowLiteralArguments],
  ['uniq', validateOptionsOnly],
  ['uptime', allowLiteralArguments],
  ['wc', validateWc],
  ['which', validateCommandNames],
  ['xmllint', validateXmllint],
])

const linuxCommandValidators = new Map<string, CommandValidator>([
  ['free', allowLiteralArguments],
  ['iostat', allowLiteralArguments],
  ['lsblk', allowLiteralArguments],
  ['lscpu', allowLiteralArguments],
  ['lsmem', allowLiteralArguments],
  ['mpstat', allowLiteralArguments],
  ['nproc', allowLiteralArguments],
  ['pidof', allowLiteralArguments],
  ['sensors', validateSensors],
  ['ss', validateSs],
  ['systemctl', validateSystemctl],
  ['top', validateLinuxTop],
  ['vmstat', allowLiteralArguments],
])

const darwinCommandValidators = new Map<string, CommandValidator>([
  ['pmset', validatePmset],
  ['sw_vers', validateSwVers],
  ['sysctl', validateSysctl],
  ['top', validateDarwinTop],
  ['vm_stat', validateVmStat],
])

const readOnlySystemctlOperations = new Set([
  'is-active',
  'is-enabled',
  'is-failed',
  'list-dependencies',
  'list-unit-files',
  'list-units',
  'show',
  'status',
])

const readOnlyXmllintOptions = new Set([
  '--nocatalogs',
  '--nonet',
  '--noout',
  '--nowarning',
  '--quiet',
  '--strict-namespace',
])

export function classifyBashSimpleCommand(
  words: readonly string[],
  platform: NodeJS.Platform,
): ShellCommandClassification {
  let commandIndex = 0
  while (commandIndex < words.length && isAllowedEnvironmentAssignment(words[commandIndex]!))
    commandIndex += 1
  const command = words[commandIndex]
  if (!command || !/^[\w.+-]+$/.test(command))
    return requireShellApproval('unsupported-syntax')
  const arguments_ = words.slice(commandIndex + 1)
  if (command === 'git' || (platform === OPERATING_SYSTEM.Windows && command === 'git.exe'))
    return classifyGitCommand(arguments_)
  if (command === 'true' || command === 'false')
    return arguments_.length === 0 ? { type: 'auto-approve' } : requireShellApproval('unsafe-arguments')
  if (command === 'node') {
    return arguments_.length === 1 && ['--version', '-v'].includes(arguments_[0]!)
      ? { type: 'auto-approve' }
      : requireShellApproval('unsafe-arguments')
  }
  if (command === 'cat' || command === 'ls')
    return classifyFileQuery(command, arguments_)
  if (command === 'rm' && (platform === OPERATING_SYSTEM.Linux || platform === OPERATING_SYSTEM.MacOS))
    return classifyFileDeletion(arguments_)
  const validator = platformCommandValidators(platform).get(command)
    ?? commonCommandValidators.get(command)
  if (!validator)
    return requireShellApproval('unknown-command')
  return validator(arguments_) ? { type: 'auto-approve' } : requireShellApproval('unsafe-arguments')
}

function classifyFileDeletion(arguments_: readonly string[]): ShellCommandClassification {
  const paths: string[] = []
  let pathMode = false
  for (const argument of arguments_) {
    if (!pathMode && argument === '--') {
      pathMode = true
      continue
    }
    if (!pathMode && argument.startsWith('-')) {
      if (/^-f+$/.test(argument) || argument === '--force')
        continue
      return requireShellApproval('unsafe-arguments')
    }
    if (!argument.trim() || /\p{Cc}/u.test(argument) || argument.split('/').includes('..'))
      return requireShellApproval('unsafe-arguments')
    paths.push(argument)
  }
  if (!paths.length || paths.length > MAX_TARGET_PATHS)
    return requireShellApproval('unsafe-arguments')
  return { access: 'delete', paths, type: 'file-operation' }
}

function classifyFileQuery(command: 'cat' | 'ls', arguments_: readonly string[]): ShellCommandClassification {
  const paths: string[] = []
  let pathMode = false
  for (const argument of arguments_) {
    if (!pathMode && argument === '--') {
      pathMode = true
      continue
    }
    if (!pathMode && argument.startsWith('-') && argument !== '-') {
      const valid = command === 'cat'
        ? /^-[AbEens-vT]+$/.test(argument) || ['--number', '--number-nonblank', '--squeeze-blank', '--show-all', '--show-ends', '--show-tabs', '--show-nonprinting'].includes(argument)
        : /^-[a-dA-Df-iF-Ik-xLNOQRSUWX1]+$/.test(argument) || ['--all', '--almost-all', '--directory', '--human-readable', '--color=never', '--color=auto', '--classify', '--group-directories-first'].includes(argument)
      if (!valid)
        return requireShellApproval('unsafe-arguments')
      continue
    }
    if (argument.includes('\0'))
      return requireShellApproval('unsafe-arguments')
    if (command !== 'cat' || argument !== '-')
      paths.push(argument)
  }
  return { type: 'auto-approve', readPaths: paths.length ? paths : command === 'ls' ? ['.'] : [] }
}

function platformCommandValidators(
  platform: NodeJS.Platform,
): ReadonlyMap<string, CommandValidator> {
  if (platform === OPERATING_SYSTEM.Linux)
    return linuxCommandValidators
  if (platform === OPERATING_SYSTEM.MacOS)
    return darwinCommandValidators
  return new Map()
}

function isAllowedEnvironmentAssignment(word: string): boolean {
  const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(word)
  if (!match)
    return false
  return allowedEnvironment.get(match[1]!)?.test(match[2]!) ?? false
}

function allowLiteralArguments(): boolean {
  return true
}

function validateDf(arguments_: readonly string[]): boolean {
  return !arguments_.includes('--sync')
}

function validateAwk(arguments_: readonly string[]): boolean {
  let index = 0
  while (index < arguments_.length) {
    const argument = arguments_[index]!
    if (argument === '--') {
      index += 1
      break
    }
    if (argument === '-F' || argument === '-v') {
      if (!arguments_[index + 1])
        return false
      index += 2
      continue
    }
    if (/^-F.+/.test(argument) || /^-v[A-Za-z_]\w*=/.test(argument)) {
      index += 1
      continue
    }
    if (argument === '--posix' || argument === '--traditional') {
      index += 1
      continue
    }
    break
  }
  const program = arguments_[index]
  if (!program || index !== arguments_.length - 1)
    return false
  return !/(?:^|\W)(?:ENVIRON|getline|system)(?:\W|$)|[<>|]|@\s*(?:include|load)\b/.test(program)
}

function validateGrep(arguments_: readonly string[]): boolean {
  if (arguments_.some(argument => /^(?:-[fRr]|--(?:directories|exclude-from|file|include|recursive))(?:$|=)/.test(argument)))
    return false
  return arguments_.filter(argument => !argument.startsWith('-')).length === 1
}

function validateHead(arguments_: readonly string[]): boolean {
  return validateStreamSlice(arguments_, false)
}

function validateTail(arguments_: readonly string[]): boolean {
  return validateStreamSlice(arguments_, true)
}

function validateStreamSlice(arguments_: readonly string[], tail: boolean): boolean {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (/^-\d+$/.test(argument) || /^--(?:bytes|lines)=[+-]?\d+$/.test(argument))
      continue
    if (argument === '-c' || argument === '-n' || argument === '--bytes' || argument === '--lines') {
      if (!/^[+-]?\d+$/.test(arguments_[index + 1] ?? ''))
        return false
      index += 1
      continue
    }
    if (['-q', '-v', '--quiet', '--verbose', '--zero-terminated'].includes(argument))
      continue
    if (tail && /^(?:-f|--follow|--pid|--retry)(?:$|=)/.test(argument))
      return false
    return false
  }
  return true
}

function validateHostname(arguments_: readonly string[]): boolean {
  return arguments_.every(argument => new Set([
    '-d',
    '-f',
    '-i',
    '-I',
    '-s',
    '--domain',
    '--fqdn',
    '--ip-address',
    '--short',
  ]).has(argument))
}

function validatePrintf(arguments_: readonly string[]): boolean {
  return !arguments_.includes('-v')
}

function validatePgrep(arguments_: readonly string[]): boolean {
  return !arguments_.some(argument => /^(?:--mrelease|--signal)(?:$|=)/.test(argument))
}

function validateRg(arguments_: readonly string[]): boolean {
  if (arguments_.some(argument => /^(?:--pre|--pre-glob)(?:$|=)/.test(argument)))
    return false
  if (arguments_.includes('--files'))
    return arguments_.every(argument => argument === '.' || argument.startsWith('-'))
  return validateGrep(arguments_)
}

function validateSort(arguments_: readonly string[]): boolean {
  return arguments_.every(argument => (
    argument.startsWith('-')
    && !/^(?:-o|-T|--(?:compress-program|files0-from|output|temporary-directory))/.test(argument)
  ))
}

function validateSensors(arguments_: readonly string[]): boolean {
  return !hasShortOption(arguments_, 's')
    && !arguments_.some(argument => /^--set(?:$|=)/.test(argument))
}

function validateSs(arguments_: readonly string[]): boolean {
  return !['D', 'E', 'K'].some(option => hasShortOption(arguments_, option))
    && !arguments_.some(argument => /^(?:--diag|--events|--kill)(?:$|=)/.test(argument))
}

function validateSystemctl(arguments_: readonly string[]): boolean {
  if (
    ['H', 'M'].some(option => hasShortOption(arguments_, option))
    || arguments_.some(argument => (
      /^(?:--host|--image|--machine|--root|--transport)(?:$|=)/.test(argument)
    ))
  ) {
    return false
  }
  const operation = arguments_.find(argument => !argument.startsWith('-'))
  return operation !== undefined && readOnlySystemctlOperations.has(operation)
}

function validateLinuxTop(arguments_: readonly string[]): boolean {
  const batch = hasShortOption(arguments_, 'b')
    || arguments_.includes('--batch-mode')
  const bounded = arguments_.some((argument, index) => (
    /^-[^-]*n\d+$/.test(argument)
    || /^--iterations=\d+$/.test(argument)
    || (
      /^-[^-]*n$/.test(argument)
      && /^\d+$/.test(arguments_[index + 1] ?? '')
    )
  ))
  return batch && bounded
}

function validateDarwinTop(arguments_: readonly string[]): boolean {
  return arguments_.some((argument, index) => (
    /^-l\d+$/.test(argument)
    || (argument === '-l' && /^\d+$/.test(arguments_[index + 1] ?? ''))
  ))
}

function validateTr(arguments_: readonly string[]): boolean {
  const operands = arguments_.filter(argument => !argument.startsWith('-'))
  return operands.length >= 1 && operands.length <= 2
}

function validateWc(arguments_: readonly string[]): boolean {
  return arguments_.every(argument => (
    argument.startsWith('-') && !/^--files0-from(?:$|=)/.test(argument)
  ))
}

function validateXmllint(arguments_: readonly string[]): boolean {
  return arguments_.includes('--noout')
    && arguments_.some(isLocalRelativePath)
    && arguments_.every(argument => (
      readOnlyXmllintOptions.has(argument) || isLocalRelativePath(argument)
    ))
}

function validateSwVers(arguments_: readonly string[]): boolean {
  const options = new Set([
    '-buildVersion',
    '-productName',
    '-productVersion',
    '-productVersionExtra',
  ])
  return arguments_.every(argument => options.has(argument))
}

function validateSysctl(arguments_: readonly string[]): boolean {
  const options = new Set(['-a', '-b', '-e', '-n'])
  return arguments_.length > 0
    && arguments_.every(argument => (
      options.has(argument) || /^[\w.-]+$/.test(argument)
    ))
}

function validateVmStat(arguments_: readonly string[]): boolean {
  return arguments_.length === 0
    || (arguments_.length === 2 && arguments_.every(argument => /^\d+$/.test(argument)))
}

function validatePmset(arguments_: readonly string[]): boolean {
  return arguments_.length > 0 && arguments_[0] === '-g'
}

function isLocalRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.includes(':')
    && !value.split('/').includes('..')
}

function validateOptionsOnly(arguments_: readonly string[]): boolean {
  return arguments_.every(argument => argument.startsWith('-'))
}

function validateCommandNames(arguments_: readonly string[]): boolean {
  return arguments_.length > 0 && arguments_.every(argument => /^[\w.+-]+$/.test(argument))
}

function hasShortOption(arguments_: readonly string[], option: string): boolean {
  return arguments_.some(argument => (
    argument.startsWith('-')
    && !argument.startsWith('--')
    && argument.slice(1).includes(option)
  ))
}
