import type { BubbleToolbarAction } from './actionRegistry'
import { translate } from '@/i18n'

interface BubbleToolbarActionState {
  active: boolean
  disabled: boolean
}

type BubbleToolbarActionContent
  = | {
    kind: 'text'
    value: string
    style: BubbleToolbarTextStyle
  }
  | {
    kind: 'icon'
    icon: string
  }

type BubbleToolbarGroupItem
  = BubbleToolbarComponentItem | BubbleToolbarActionItem

type BubbleToolbarComponent = 'turn-into' | 'color' | 'align'

export type BubbleToolbarVariant = 'text' | 'image'
export type BubbleToolbarTextStyle = 'mark-strong' | 'mark-italic' | 'mark-underline' | 'mark-strike' | 'label'

interface BubbleToolbarComponentItem {
  kind: 'component'
  component: BubbleToolbarComponent
  description?: string
}

interface BubbleToolbarActionItem {
  kind: 'action'
  action: BubbleToolbarAction
  description?: string
  content: BubbleToolbarActionContent
  buttonVariant?: 'default' | 'wide'
}

export interface BubbleToolbarGroup {
  key: string
  items: readonly BubbleToolbarGroupItem[]
}

export type BubbleToolbarViewGroupItem
  = BubbleToolbarComponentItem
    | (BubbleToolbarActionItem & BubbleToolbarActionState)

export type BubbleToolbarViewGroup = Omit<BubbleToolbarGroup, 'items'> & {
  items: readonly BubbleToolbarViewGroupItem[]
}

const TEXT_BUBBLE_TOOLBAR_GROUPS = [
  {
    key: 'text',
    items: [
      {
        kind: 'component',
        component: 'turn-into',
        description: 'Text',
      },
    ],
  },
  {
    key: 'align',
    items: [
      {
        kind: 'component',
        component: 'align',
        description: 'Align and indent',
      },
    ],
  },
  {
    key: 'marks',
    items: [
      {
        kind: 'action',
        action: 'bold',
        description: 'Bold',
        content: {
          kind: 'text',
          value: 'B',
          style: 'mark-strong',
        },
      },
      {
        kind: 'action',
        action: 'italic',
        description: 'Italic',
        content: {
          kind: 'text',
          value: 'I',
          style: 'mark-italic',
        },
      },
      {
        kind: 'action',
        action: 'underline',
        description: 'Underline',
        content: {
          kind: 'text',
          value: 'U',
          style: 'mark-underline',
        },
      },
      {
        kind: 'action',
        action: 'strike',
        description: 'Strikethrough',
        content: {
          kind: 'text',
          value: 'S',
          style: 'mark-strike',
        },
      },
      {
        kind: 'action',
        action: 'code',
        description: 'Code',
        content: {
          kind: 'icon',
          icon: 'code',
        },
      },
    ],
  },
  {
    key: 'link',
    items: [
      {
        kind: 'action',
        action: 'link',
        description: 'Link',
        content: {
          kind: 'icon',
          icon: 'link',
        },
      },
    ],
  },
  {
    key: 'color',
    items: [
      {
        kind: 'component',
        component: 'color',
        description: 'Color',
      },
    ],
  },
  {
    key: 'selection-context',
    items: [
      {
        kind: 'action',
        action: 'add-selection-context',
        description: 'Add to chat',
        content: {
          kind: 'text',
          value: 'Add to chat',
          style: 'label',
        },
        buttonVariant: 'wide',
      },
    ],
  },
  {
    key: 'comment',
    items: [
      {
        kind: 'action',
        action: 'comment',
        description: 'Comment',
        content: {
          kind: 'icon',
          icon: 'comment',
        },
      },
    ],
  },
] as const satisfies readonly BubbleToolbarGroup[]

const IMAGE_BUBBLE_TOOLBAR_GROUPS = [
  {
    key: 'image-alt',
    items: [
      {
        kind: 'action',
        action: 'edit-image-alt',
        description: 'Edit description',
        content: {
          kind: 'text',
          value: 'Edit description',
          style: 'label',
        },
        buttonVariant: 'wide',
      },
    ],
  },
  {
    key: 'image-align',
    items: [
      {
        kind: 'action',
        action: 'align-left',
        description: 'Align left',
        content: {
          kind: 'text',
          value: 'Align left',
          style: 'label',
        },
        buttonVariant: 'wide',
      },
      {
        kind: 'action',
        action: 'align-center',
        description: 'Align center',
        content: {
          kind: 'text',
          value: 'Align center',
          style: 'label',
        },
        buttonVariant: 'wide',
      },
      {
        kind: 'action',
        action: 'align-right',
        description: 'Align right',
        content: {
          kind: 'text',
          value: 'Align right',
          style: 'label',
        },
        buttonVariant: 'wide',
      },
    ],
  },
  {
    key: 'image-comment',
    items: [
      {
        kind: 'action',
        action: 'comment',
        description: 'Comment',
        content: {
          kind: 'text',
          value: 'Comment',
          style: 'label',
        },
        buttonVariant: 'wide',
      },
    ],
  },
] as const satisfies readonly BubbleToolbarGroup[]

export function getBubbleToolbarViewGroups(
  variant: BubbleToolbarVariant,
  getActionState: (action: BubbleToolbarAction) => BubbleToolbarActionState,
): BubbleToolbarViewGroup[] {
  const groups = variant === 'image'
    ? IMAGE_BUBBLE_TOOLBAR_GROUPS
    : TEXT_BUBBLE_TOOLBAR_GROUPS

  return groups.map(group => ({
    ...group,
    items: group.items.map((item) => {
      if (item.kind === 'component') {
        return {
          ...item,
          description: getComponentDescription(item.component),
        }
      }

      return {
        ...item,
        description: getActionDescription(item.action),
        content: translateActionContent(item),
        ...getActionState(item.action),
      }
    }),
  }))
}

function getComponentDescription(component: BubbleToolbarComponent) {
  const keyMap = {
    'turn-into': 'editor.common.textStyle',
    'color': 'editor.common.color',
    'align': 'editor.common.alignAndIndent',
  } as const

  return translate(keyMap[component])
}

function getActionDescription(action: BubbleToolbarAction) {
  const keyMap = {
    'bold': 'editor.common.bold',
    'italic': 'editor.common.italic',
    'underline': 'editor.common.underline',
    'strike': 'editor.common.strike',
    'code': 'editor.common.code',
    'link': 'editor.common.link',
    'add-selection-context': 'editor.common.addToChat',
    'comment': 'editor.common.comment',
    'edit-image-alt': 'editor.common.editDescription',
    'align-left': 'editor.common.leftAlign',
    'align-center': 'editor.common.centerAlign',
    'align-right': 'editor.common.rightAlign',
    'indent': 'editor.common.indent',
    'outdent': 'editor.common.outdent',
  } as const

  return translate(keyMap[action])
}

function translateActionContent(item: BubbleToolbarActionItem): BubbleToolbarActionContent {
  if (item.content.kind === 'icon' || item.content.style !== 'label') {
    return item.content
  }

  return {
    ...item.content,
    value: getActionDescription(item.action),
  }
}
