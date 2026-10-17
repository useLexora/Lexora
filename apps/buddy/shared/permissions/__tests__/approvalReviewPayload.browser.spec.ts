import { describe, expect, it } from 'vitest'
import {
  approvalReviewPayloadMatchesKind,
  approvalReviewPayloadSchema,
  createApprovalReviewPayload,
} from '../approvalReviewPayload'

const BROWSER_REVIEW = {
  action: 'click' as const,
  actionDigest: 'a'.repeat(64),
  documentRevision: 2,
  effect: 'publish' as const,
  key: null,
  observationId: 'b3a5d63b-17b7-4b5a-863a-37f135e297d4',
  origin: 'https://example.com',
  pageId: 'ed312709-baf9-44b3-a292-108055838477',
  risk: 'commit-like' as const,
  sessionId: '6f828cc1-6549-4245-b26e-43b2917c9281',
  targetName: 'Publish now',
  targetRole: 'button',
}

describe('browser approval review payload', () => {
  it('reads existing one-time reviews and supports explicit reusable scopes', () => {
    const payload = createApprovalReviewPayload({
      allowForTurn: false,
      arguments: { action: { kind: 'click', ref: 'e1' } },
      browser: BROWSER_REVIEW,
      kind: 'browser',
      toolName: 'lexora_browser_act',
    })

    expect(payload).toEqual({
      ...BROWSER_REVIEW,
      allowForTurn: false,
      card: 'browser-action',
      toolName: 'lexora_browser_act',
    })
    expect(approvalReviewPayloadMatchesKind(payload, 'browser')).toBe(true)
    expect(approvalReviewPayloadSchema.safeParse({
      ...payload,
      allowForTurn: true,
      reuseScopes: ['operation', 'source', 'turn'],
    }).success).toBe(true)
  })

  it.each([
    ['fill', null],
    ['type', null],
    ['select', null],
    ['navigate', null],
    ['back', null],
    ['forward', null],
    ['reload', null],
    ['click', null],
    ['press', 'Enter'],
    ['press', 'Tab'],
    ['press', 'Delete'],
  ])('supports neutral %s interaction reviews', (action, key) => {
    const review = {
      ...BROWSER_REVIEW,
      action,
      key,
      risk: 'interaction',
      effect: null,
      allowForTurn: true,
      card: 'browser-action',
      toolName: 'lexora_browser_act',
    }
    expect(approvalReviewPayloadSchema.safeParse(review).success).toBe(true)
    expect(approvalReviewPayloadSchema.safeParse({ ...review, effect: 'publish' }).success).toBe(false)
    expect(approvalReviewPayloadSchema.safeParse({ ...review, key: key ? null : 'Enter' }).success).toBe(false)
  })

  it('rejects private input outside the browser review contract', () => {
    expect(approvalReviewPayloadSchema.safeParse({
      ...BROWSER_REVIEW,
      allowForTurn: false,
      card: 'browser-action',
      input: 'private input',
      toolName: 'lexora_browser_act',
    }).success).toBe(false)
  })

  it.each(['actionDigest', 'documentRevision', 'observationId', 'pageId', 'sessionId'])(
    'requires the %s approval binding',
    (field) => {
      const card = {
        ...BROWSER_REVIEW,
        allowForTurn: false,
        card: 'browser-action',
        toolName: 'lexora_browser_act',
      }
      delete (card as Record<string, unknown>)[field]
      expect(approvalReviewPayloadSchema.safeParse(card).success).toBe(false)
    },
  )
})
