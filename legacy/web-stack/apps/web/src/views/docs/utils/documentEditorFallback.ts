import type { DocsDocumentEditorFallbackProps } from '../typing'
import { DOCUMENT_PANE_STATE } from '@haohaoxue/lexora-contracts/document/constants'
import { SvgIconCategory } from '@/components/svg-icon/typing'
import { translate } from '@/i18n'

/**
 * 回退态操作。
 */
export interface DocumentEditorFallbackAction {
  event: 'createDocument' | 'openFallbackDocument' | 'retryLoad'
  label: string
  type?: 'primary' | 'default'
}

/**
 * 回退态展示数据。
 */
export interface DocumentEditorFallbackState {
  title: string
  description: string
  iconCategory: SvgIconCategory
  icon: string
  spin?: boolean
  actions: DocumentEditorFallbackAction[]
}

export function resolveDocumentEditorFallbackState(
  props: DocsDocumentEditorFallbackProps,
): DocumentEditorFallbackState {
  if (props.contentError) {
    return {
      title: translate('docs.fallback.contentErrorTitle'),
      description: props.hasFallbackDocument
        ? translate('docs.fallback.contentErrorDescription')
        : translate('docs.fallback.contentErrorRetryDescription'),
      iconCategory: SvgIconCategory.UI,
      icon: 'warning',
      actions: [
        {
          event: 'retryLoad',
          label: translate('docs.fallback.retry'),
          type: 'primary',
        },
        ...(
          props.hasFallbackDocument
            ? [{
                event: 'openFallbackDocument' as const,
                label: translate('docs.fallback.openAvailableDocument'),
              }]
            : []
        ),
      ],
    }
  }

  if (props.paneState === DOCUMENT_PANE_STATE.LOADING) {
    return {
      title: translate('docs.fallback.loadingTitle'),
      description: props.isLoading
        ? translate('docs.fallback.loadingCurrentDescription')
        : translate('docs.fallback.loadingRecentDescription'),
      iconCategory: SvgIconCategory.UI,
      icon: 'spinner-orbit',
      spin: true,
      actions: [],
    }
  }

  if (props.paneState === DOCUMENT_PANE_STATE.EMPTY) {
    return {
      title: translate('docs.fallback.emptyTitle'),
      description: translate('docs.fallback.emptyDescription'),
      iconCategory: SvgIconCategory.UI,
      icon: 'document-add',
      actions: [
        {
          event: 'createDocument',
          label: translate('docs.fallback.createFirstDocument'),
          type: 'primary',
        },
      ],
    }
  }

  if (props.paneState === DOCUMENT_PANE_STATE.UNSUPPORTED_SCHEMA) {
    return {
      title: translate('docs.fallback.unsupportedTitle'),
      description: props.hasFallbackDocument
        ? translate('docs.fallback.unsupportedDescription')
        : translate('docs.fallback.unsupportedRetryDescription'),
      iconCategory: SvgIconCategory.UI,
      icon: 'warning',
      actions: props.hasFallbackDocument
        ? [
            {
              event: 'openFallbackDocument',
              label: translate('docs.fallback.openAvailableDocument'),
              type: 'primary',
            },
          ]
        : [
            {
              event: 'createDocument',
              label: translate('docs.fallback.createDocument'),
              type: 'primary',
            },
          ],
    }
  }

  if (props.paneState === DOCUMENT_PANE_STATE.NOT_FOUND) {
    return {
      title: translate('docs.fallback.notFoundTitle'),
      description: translate('docs.fallback.notFoundDescription'),
      iconCategory: SvgIconCategory.UI,
      icon: 'document-unknown',
      actions: props.hasFallbackDocument
        ? [
            {
              event: 'openFallbackDocument',
              label: translate('docs.fallback.openAvailableDocument'),
              type: 'primary',
            },
          ]
        : [
            {
              event: 'createDocument',
              label: translate('docs.fallback.createDocument'),
              type: 'primary',
            },
          ],
    }
  }

  if (props.paneState === DOCUMENT_PANE_STATE.FORBIDDEN) {
    return {
      title: translate('docs.fallback.forbiddenTitle'),
      description: translate('docs.fallback.forbiddenDescription'),
      iconCategory: SvgIconCategory.UI,
      icon: 'lock',
      actions: props.hasFallbackDocument
        ? [
            {
              event: 'openFallbackDocument',
              label: translate('docs.fallback.openAvailableDocument'),
              type: 'primary',
            },
          ]
        : [],
    }
  }

  if (props.paneState === DOCUMENT_PANE_STATE.ERROR) {
    return {
      title: translate('docs.fallback.errorTitle'),
      description: translate('docs.fallback.errorDescription'),
      iconCategory: SvgIconCategory.UI,
      icon: 'warning',
      actions: [
        {
          event: 'retryLoad',
          label: translate('docs.fallback.retry'),
          type: 'primary',
        },
        ...(
          props.hasFallbackDocument
            ? [{
                event: 'openFallbackDocument' as const,
                label: translate('docs.fallback.openAvailableDocument'),
              }]
            : []
        ),
      ],
    }
  }

  return {
    title: translate('docs.fallback.selectTitle'),
    description: translate('docs.fallback.selectDescription'),
    iconCategory: SvgIconCategory.UI,
    icon: 'document-view',
    actions: props.hasFallbackDocument
      ? [
          {
            event: 'openFallbackDocument',
            label: translate('docs.fallback.openFirstDocument'),
            type: 'primary',
          },
        ]
      : [
          {
            event: 'createDocument',
            label: translate('docs.fallback.createDocument'),
            type: 'primary',
          },
        ],
  }
}
