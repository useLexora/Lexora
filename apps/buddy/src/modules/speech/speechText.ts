import type { Token, Tokens } from 'marked'
import { marked } from 'marked'

function speak(tokens: Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case 'code':
      case 'image':
      case 'html':
      case 'def':
      case 'hr': return ''
      case 'br':
      case 'space': return '\n'
      case 'list': return token.items.map((item: Tokens.ListItem) => speak(item.tokens)).join('\n')
      case 'table': return [token.header, ...token.rows].map(row => row.map((cell: Tokens.TableCell) => speak(cell.tokens)).join(', ')).join('\n')
      default: {
        const text = 'tokens' in token && token.tokens ? speak(token.tokens) : 'text' in token ? token.text : ''
        return ['paragraph', 'heading', 'blockquote'].includes(token.type) ? `${text}\n` : text
      }
    }
  }).join('')
}

export function speechText(markdown: string): string {
  return speak(marked.lexer(markdown)).replace(/\n{3,}/g, '\n\n').trim()
}
