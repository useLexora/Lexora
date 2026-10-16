import { Extension } from '@tiptap/core'

const TEXT_COLOR_CLASS_PATTERN = /^tiptap-highlight-[a-z-]+-text$/
const BACKGROUND_COLOR_CLASS_PATTERN = /^tiptap-highlight-[a-z-]+-bg$/

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    lexoraTextColorClass: {
      setTextColorClass: (className: string) => ReturnType
      unsetTextColorClass: () => ReturnType
    }
    lexoraHighlightClass: {
      setHighlightClass: (className: string) => ReturnType
      unsetHighlightClass: () => ReturnType
    }
  }
}

export const TextColorClass = Extension.create({
  name: 'textColorClass',

  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          textColorClass: {
            default: null,
            parseHTML: element => findMatchingClassName(element, TEXT_COLOR_CLASS_PATTERN),
            renderHTML: attributes => renderClassName(attributes.textColorClass),
          },
          backgroundColorClass: {
            default: null,
            parseHTML: element => findMatchingClassName(element, BACKGROUND_COLOR_CLASS_PATTERN),
            renderHTML: attributes => renderClassName(attributes.backgroundColorClass),
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setTextColorClass: className => ({ chain }) =>
        chain()
          .setMark('textStyle', { textColorClass: className || null })
          .removeEmptyTextStyle()
          .run(),
      unsetTextColorClass: () => ({ chain }) =>
        chain()
          .setMark('textStyle', { textColorClass: null })
          .removeEmptyTextStyle()
          .run(),
      setHighlightClass: className => ({ chain }) =>
        chain()
          .setMark('textStyle', { backgroundColorClass: className || null })
          .removeEmptyTextStyle()
          .run(),
      unsetHighlightClass: () => ({ chain }) =>
        chain()
          .setMark('textStyle', { backgroundColorClass: null })
          .removeEmptyTextStyle()
          .run(),
    }
  },
})

function findMatchingClassName(element: HTMLElement, pattern: RegExp) {
  return Array.from(element.classList).find(className => pattern.test(className)) ?? null
}

function renderClassName(className: unknown) {
  if (typeof className !== 'string' || !className) {
    return {}
  }

  return {
    class: className,
  }
}
