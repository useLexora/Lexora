import { describe, expect, it } from 'vitest'

import {
  beginReturningToChatTail,
  createChatScrollState,
  observeChatScroll,
  reconcileChatScrollOwnership,
  recordProgrammaticChatScroll,
  resetChatScrollToTail,
} from '../chatScroll'

describe('desktopChatScroll', () => {
  it('keeps delayed programmatic scroll events inside the observed-top ledger', () => {
    const atTail = {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 1_000,
    }
    const written = recordProgrammaticChatScroll(
      createChatScrollState(),
      atTail,
    )

    expect(observeChatScroll(written, atTail)).toEqual({
      movedByReader: false,
      state: {
        observedTop: 1_000,
        ownership: 'following',
      },
    })
  })

  it('gives every unregistered upward movement permanent reader ownership', () => {
    const atTail = recordProgrammaticChatScroll(createChatScrollState(), {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 1_000,
    })
    const detached = observeChatScroll(atTail, {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 700,
    })

    expect(detached).toEqual({
      movedByReader: true,
      state: {
        observedTop: 700,
        ownership: 'detached',
      },
    })
    expect(observeChatScroll(detached.state, {
      clientHeight: 600,
      scrollHeight: 2_000,
      scrollTop: 700,
    })).toEqual({
      movedByReader: false,
      state: {
        observedTop: 700,
        ownership: 'detached',
      },
    })
  })

  it('absorbs a browser floor clamp without changing follow ownership', () => {
    const following = recordProgrammaticChatScroll(createChatScrollState(), {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 1_000,
    })

    expect(observeChatScroll(following, {
      clientHeight: 600,
      scrollHeight: 1_300,
      scrollTop: 700,
    })).toEqual({
      movedByReader: false,
      state: {
        observedTop: 700,
        ownership: 'following',
      },
    })
  })

  it('returns to follow ownership when a floor clamp leaves the position at the tail', () => {
    const clamped = observeChatScroll({
      observedTop: 700,
      ownership: 'detached',
    }, {
      clientHeight: 600,
      scrollHeight: 1_000,
      scrollTop: 400,
    })

    expect(clamped).toEqual({
      movedByReader: false,
      state: {
        observedTop: 400,
        ownership: 'following',
      },
    })
  })

  it('reconciles a reader left at the tail by shrinking content', () => {
    const detached = {
      observedTop: 700,
      ownership: 'detached',
    } as const

    expect(reconcileChatScrollOwnership(detached, {
      clientHeight: 600,
      scrollHeight: 600,
      scrollTop: 0,
    })).toEqual({
      observedTop: 0,
      ownership: 'following',
    })
    expect(reconcileChatScrollOwnership(detached, {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 700,
    })).toBe(detached)
  })

  it('lets reverse reader movement interrupt a return to the tail', () => {
    const returning = beginReturningToChatTail({
      observedTop: 700,
      ownership: 'detached',
    })
    const interrupted = observeChatScroll(returning, {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 650,
    })

    expect(interrupted.state.ownership).toBe('detached')
    expect(interrupted.movedByReader).toBe(true)

    const completed = recordProgrammaticChatScroll(returning, {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 1_000,
    })
    expect(completed.ownership).toBe('following')
  })

  it('keeps following ownership when scroll occurs without user initiation (e.g. window resize or split layout changes)', () => {
    const following = recordProgrammaticChatScroll(createChatScrollState(), {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 1_000,
    })

    const result = observeChatScroll(
      following,
      { clientHeight: 500, scrollHeight: 1_600, scrollTop: 800 },
      { userInitiated: false },
    )

    expect(result).toEqual({
      movedByReader: false,
      state: {
        observedTop: 800,
        ownership: 'following',
      },
    })
  })

  it('only detaches when user explicitly scrolls away from tail', () => {
    const following = recordProgrammaticChatScroll(createChatScrollState(), {
      clientHeight: 600,
      scrollHeight: 1_600,
      scrollTop: 1_000,
    })

    const detached = observeChatScroll(
      following,
      { clientHeight: 600, scrollHeight: 1_600, scrollTop: 500 },
      { userInitiated: true },
    )
    expect(detached).toEqual({
      movedByReader: true,
      state: {
        observedTop: 500,
        ownership: 'detached',
      },
    })

    const backToTail = observeChatScroll(
      detached.state,
      { clientHeight: 600, scrollHeight: 1_600, scrollTop: 1_000 },
      { userInitiated: true },
    )
    expect(backToTail).toEqual({
      movedByReader: false,
      state: {
        observedTop: 1_000,
        ownership: 'following',
      },
    })
  })

  it('resets scroll state to following with resetChatScrollToTail', () => {
    const reset = resetChatScrollToTail({ clientHeight: 600, scrollHeight: 1_600, scrollTop: 1_000 })
    expect(reset).toEqual({
      observedTop: 1_000,
      ownership: 'following',
    })
  })
})
