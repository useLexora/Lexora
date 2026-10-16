import type { CommandProps } from '@tiptap/core'
import { Extension } from '@tiptap/core'

type TextAlignValue = 'left' | 'center' | 'right'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    lexoraTextAlign: {
      setTextAlign: (value: TextAlignValue) => ReturnType
      unsetTextAlign: () => ReturnType
    }
  }
}

const TEXT_ALIGN_TYPES = ['paragraph', 'heading'] as const

export const TextAlign = Extension.create({
  name: 'textAlign',

  addGlobalAttributes() {
    return [
      {
        types: [...TEXT_ALIGN_TYPES],
        attributes: {
          textAlign: {
            default: undefined,
            parseHTML: (element) => {
              const textAlign = element.style.textAlign

              return isTextAlignValue(textAlign) ? textAlign : undefined
            },
            renderHTML: (attributes) => {
              if (!isTextAlignValue(attributes.textAlign)) {
                return {}
              }

              return {
                style: `text-align: ${attributes.textAlign}`,
              }
            },
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setTextAlign: value => (props: CommandProps) =>
        updateCurrentBlockTextAlign(props, value),
      unsetTextAlign: () => (props: CommandProps) =>
        updateCurrentBlockTextAlign(props, undefined),
    }
  },
})

function updateCurrentBlockTextAlign(
  props: Pick<CommandProps, 'commands' | 'state'>,
  value: TextAlignValue | undefined,
) {
  const nodeTypeName = props.state.selection.$from.parent.type.name

  if (!TEXT_ALIGN_TYPES.includes(nodeTypeName as (typeof TEXT_ALIGN_TYPES)[number])) {
    return false
  }

  return props.commands.updateAttributes(nodeTypeName, {
    textAlign: value,
  })
}

function isTextAlignValue(value: unknown): value is TextAlignValue {
  return value === 'left' || value === 'center' || value === 'right'
}
