export interface CodeBlockLanguage {
  id: string
  label: string
  highlightLanguage: string
  aliases?: readonly string[]
}

export const CODE_BLOCK_DEFAULT_LANGUAGE = 'javascript'

export const CODE_BLOCK_LANGUAGES: readonly CodeBlockLanguage[] = [
  { id: 'plaintext', label: 'Plain Text', highlightLanguage: 'plaintext', aliases: ['text', 'plain'] },
  { id: 'javascript', label: 'JavaScript', highlightLanguage: 'javascript', aliases: ['js'] },
  { id: 'typescript', label: 'TypeScript', highlightLanguage: 'typescript', aliases: ['ts'] },
  { id: 'html', label: 'HTML', highlightLanguage: 'xml' },
  { id: 'css', label: 'CSS', highlightLanguage: 'css' },
  { id: 'scss', label: 'SCSS', highlightLanguage: 'scss', aliases: ['sass'] },
  { id: 'json', label: 'JSON', highlightLanguage: 'json' },
  { id: 'markdown', label: 'Markdown', highlightLanguage: 'markdown', aliases: ['md'] },
  { id: 'bash', label: 'Bash', highlightLanguage: 'bash' },
  { id: 'shell', label: 'Shell', highlightLanguage: 'shell', aliases: ['sh'] },
  { id: 'python', label: 'Python', highlightLanguage: 'python', aliases: ['py'] },
  { id: 'java', label: 'Java', highlightLanguage: 'java' },
  { id: 'c', label: 'C', highlightLanguage: 'c' },
  { id: 'cpp', label: 'C++', highlightLanguage: 'cpp', aliases: ['c++'] },
  { id: 'csharp', label: 'C#', highlightLanguage: 'csharp', aliases: ['cs', 'c#'] },
  { id: 'fsharp', label: 'F#', highlightLanguage: 'fsharp', aliases: ['fs', 'f#'] },
  { id: 'go', label: 'Go', highlightLanguage: 'go' },
  { id: 'rust', label: 'Rust', highlightLanguage: 'rust', aliases: ['rs'] },
  { id: 'kotlin', label: 'Kotlin', highlightLanguage: 'kotlin', aliases: ['kt'] },
  { id: 'swift', label: 'Swift', highlightLanguage: 'swift' },
  { id: 'php', label: 'PHP', highlightLanguage: 'php' },
  { id: 'ruby', label: 'Ruby', highlightLanguage: 'ruby', aliases: ['rb'] },
  { id: 'sql', label: 'SQL', highlightLanguage: 'sql' },
  { id: 'yaml', label: 'YAML', highlightLanguage: 'yaml', aliases: ['yml'] },
  { id: 'xml', label: 'XML', highlightLanguage: 'xml' },
  { id: 'dockerfile', label: 'Dockerfile', highlightLanguage: 'dockerfile' },
  { id: 'graphql', label: 'GraphQL', highlightLanguage: 'graphql', aliases: ['gql'] },
  { id: 'latex', label: 'LaTeX', highlightLanguage: 'latex', aliases: ['tex'] },
  { id: 'vue', label: 'Vue', highlightLanguage: 'xml' },
  { id: 'jsx', label: 'React / JSX', highlightLanguage: 'javascript' },
  { id: 'tsx', label: 'TSX', highlightLanguage: 'typescript' },
  { id: 'regex', label: 'Regex', highlightLanguage: 'plaintext', aliases: ['regexp'] },
  { id: 'diff', label: 'Diff', highlightLanguage: 'diff' },
  { id: 'toml', label: 'TOML', highlightLanguage: 'ini' },
  { id: 'ini', label: 'INI', highlightLanguage: 'ini' },
  { id: 'makefile', label: 'Makefile', highlightLanguage: 'makefile' },
  { id: 'lua', label: 'Lua', highlightLanguage: 'lua' },
] as const

const languageById = new Map(CODE_BLOCK_LANGUAGES.map(language => [language.id, language]))
const languageIdByAlias = new Map<string, string>()

for (const language of CODE_BLOCK_LANGUAGES) {
  languageIdByAlias.set(language.id.toLowerCase(), language.id)
  languageIdByAlias.set(language.label.toLowerCase(), language.id)

  for (const alias of language.aliases ?? []) {
    languageIdByAlias.set(alias.toLowerCase(), language.id)
  }
}

export function normalizeCodeBlockLanguage(language: unknown) {
  if (typeof language !== 'string') {
    return CODE_BLOCK_DEFAULT_LANGUAGE
  }

  const normalized = language.trim().toLowerCase()

  if (!normalized) {
    return CODE_BLOCK_DEFAULT_LANGUAGE
  }

  return languageIdByAlias.get(normalized) ?? CODE_BLOCK_DEFAULT_LANGUAGE
}

export function resolveCodeBlockLanguage(language: unknown) {
  return languageById.get(normalizeCodeBlockLanguage(language)) ?? languageById.get(CODE_BLOCK_DEFAULT_LANGUAGE)!
}
