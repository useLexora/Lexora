interface State {
  epsilon: number[]
  characters?: ReadonlySet<string>
  next?: number
}

interface Fragment {
  start: number
  end: number
}

const ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32))
const cache = new Map<string, ((host: string) => boolean) | null>()

export function compileNetworkRegex(pattern: string): ((host: string) => boolean) | null {
  if (!pattern || pattern.length > 256)
    return null
  if (cache.has(pattern))
    return cache.get(pattern) ?? null
  let compiled: ((host: string) => boolean) | null = null
  try {
    compiled = compile(pattern)
  }
  catch {
    compiled = null
  }
  if (cache.size >= 128)
    cache.delete(cache.keys().next().value!)
  cache.set(pattern, compiled)
  return compiled
}

function compile(pattern: string): (host: string) => boolean {
  if (!pattern || pattern.length > 256 || /[^\x21-\x7E]/.test(pattern))
    throw new Error('Invalid pattern')
  let source = pattern.startsWith('^') ? pattern.slice(1) : pattern
  if (source.endsWith('$')) {
    let escapes = 0
    for (let cursor = source.length - 2; cursor >= 0 && source[cursor] === '\\'; cursor--)
      escapes++
    if (escapes % 2 === 0)
      source = source.slice(0, -1)
  }
  if (!source)
    throw new Error('Empty pattern')
  const states: State[] = []
  let offset = 0
  function state(value: State = { epsilon: [] }): number {
    if (states.length >= 512)
      throw new Error('Pattern too complex')
    states.push(value)
    return states.length - 1
  }
  function connect(from: number, to: number) {
    states[from]!.epsilon.push(to)
  }
  function escaped(): Set<string> {
    const char = source[offset++]
    if (char === 'd')
      return new Set('0123456789')
    if (char === 'w')
      return new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_')
    if (char && '\\.[]()|*+?{}^$-'.includes(char))
      return new Set([char])
    throw new Error('Unsupported escape')
  }
  function characterClass(): Set<string> {
    const inverted = source[offset] === '^'
    if (inverted)
      offset++
    const characters = new Set<string>()
    let count = 0
    while (offset < source.length && source[offset] !== ']') {
      const token = source[offset++]
      if (!token || token === '[')
        throw new Error('Invalid character class')
      const start = token === '\\' ? escaped() : new Set([token])
      if (source[offset] === '-' && source[offset + 1] !== ']') {
        offset++
        const last = source[offset++]
        const end = last === '\\' ? escaped() : new Set(last ? [last] : [])
        const firstChar = [...start][0]
        const lastChar = [...end][0]
        if (start.size !== 1 || end.size !== 1 || !firstChar || !lastChar || firstChar > lastChar)
          throw new Error('Invalid range')
        for (let code = firstChar.charCodeAt(0); code <= lastChar.charCodeAt(0); code++)
          characters.add(String.fromCharCode(code))
      }
      else {
        for (const char of start)
          characters.add(char)
      }
      count++
    }
    if (source[offset++] !== ']' || count === 0)
      throw new Error('Unclosed character class')
    return inverted ? new Set(ASCII.filter(char => !characters.has(char))) : characters
  }
  function atom(depth: number): Fragment {
    const token = source[offset++]
    let fragment: Fragment
    if (token === '(') {
      if (depth >= 16)
        throw new Error('Pattern too deep')
      if (source.slice(offset, offset + 2) === '?:')
        offset += 2
      fragment = alternative(depth + 1)
      if (source[offset++] !== ')')
        throw new Error('Unclosed group')
    }
    else {
      if (!token || '^$)*+?{}|/'.includes(token))
        throw new Error('Unsupported token')
      const characters = token === '['
        ? characterClass()
        : token === '\\'
          ? escaped()
          : new Set(token === '.' ? ASCII : [token])
      const end = state()
      fragment = { start: state({ epsilon: [], characters, next: end }), end }
    }
    const quantifier = source[offset]
    if (quantifier === '*' || quantifier === '+' || quantifier === '?') {
      offset++
      const start = state()
      const end = state()
      connect(start, fragment.start)
      connect(fragment.end, end)
      if (quantifier !== '+')
        connect(start, end)
      if (quantifier !== '?')
        connect(fragment.end, fragment.start)
      fragment = { start, end }
    }
    return fragment
  }
  function sequence(depth: number): Fragment {
    const start = state()
    let end = start
    let count = 0
    while (offset < source.length && source[offset] !== ')' && source[offset] !== '|') {
      const next = atom(depth)
      connect(end, next.start)
      end = next.end
      count++
    }
    if (count === 0)
      throw new Error('Empty branch')
    return { start, end }
  }
  function alternative(depth: number): Fragment {
    let fragment = sequence(depth)
    while (source[offset] === '|') {
      offset++
      const next = sequence(depth)
      const start = state()
      const end = state()
      connect(start, fragment.start)
      connect(start, next.start)
      connect(fragment.end, end)
      connect(next.end, end)
      fragment = { start, end }
    }
    return fragment
  }
  const fragment = alternative(0)
  if (offset !== source.length)
    throw new Error('Unexpected token')
  function closure(seeds: Iterable<number>): Set<number> {
    const active = new Set(seeds)
    for (const index of active) {
      for (const next of states[index]!.epsilon)
        active.add(next)
    }
    return active
  }
  return (host) => {
    if (host.length > 253)
      return false
    let active = closure([fragment.start])
    for (const char of host) {
      const next = new Set<number>()
      for (const index of active) {
        const current = states[index]!
        if (current.next !== undefined && current.characters?.has(char))
          next.add(current.next)
      }
      if (next.size === 0)
        return false
      active = closure(next)
    }
    return active.has(fragment.end)
  }
}
