import type {
  SemanticBrowserDriverError,
} from '../SemanticBrowserDriver'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import {
  SemanticBrowserDriver,
} from '../SemanticBrowserDriver'

const SESSION_ID = '6f828cc1-6549-4245-b26e-43b2917c9281'
const PAGE_ID = 'ed312709-baf9-44b3-a292-108055838477'
const OBSERVATION_ID = 'b3a5d63b-17b7-4b5a-863a-37f135e297d4'
const SECOND_OBSERVATION_ID = '7a2d7f0d-c0d0-4e95-a1ef-0a9f271b1f82'
const THIRD_OBSERVATION_ID = '8bf421c2-d4b7-48ca-b833-aaf1e2f63a43'
const SCREENSHOT_ID = 'da56fda3-f4de-4622-908b-39978c98194d'

interface LayoutNodeFixture {
  attributes?: Record<string, string>
  backendDOMNodeId: number
  bounds: [number, number, number, number]
  nodeName?: string
  text?: string
}

describe('semanticBrowserDriver', () => {
  it('projects meaningful AX nodes with main-frame DOM metadata and safe form values', async () => {
    const fixture = createFixture()
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })

    await expect(driver.observe(createObservationInput())).resolves.toEqual({
      documentRevision: 0,
      elements: [
        {
          actions: ['click'],
          frameId: 'main-frame',
          name: 'Continue',
          ref: 'e1',
          role: 'button',
          states: ['focusable'],
        },
        {
          actions: ['fill', 'type'],
          description: 'Used for the receipt',
          frameId: 'main-frame',
          name: 'Email address',
          ref: 'e2',
          role: 'textbox',
          states: ['focusable', 'required', 'editable'],
          value: 'reader@example.com',
          valueState: 'present',
        },
        {
          actions: [],
          frameId: 'main-frame',
          level: 2,
          name: 'Checkout',
          ref: 'e3',
          role: 'heading',
          states: [],
        },
      ],
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
      status: 'ready',
      title: 'Fixture',
      truncated: false,
      url: 'https://example.com/checkout',
    })

    expect(fixture.sendCommand).toHaveBeenNthCalledWith(1, 'Page.getFrameTree')
    expect(fixture.sendCommand).toHaveBeenNthCalledWith(2, 'DOM.getDocument', {
      depth: 0,
      pierce: true,
    })
    expect(fixture.sendCommand).toHaveBeenNthCalledWith(
      3,
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [] },
    )
    expect(fixture.sendCommand).toHaveBeenNthCalledWith(
      4,
      'Page.getLayoutMetrics',
    )
    expect(fixture.sendCommand).toHaveBeenNthCalledWith(
      5,
      'Accessibility.getFullAXTree',
      { frameId: 'main-frame' },
    )
  })

  it('normalizes Chromium searchbox nodes into fillable value controls', async () => {
    const fixture = createFixture(false, [
      createAxNode({
        backendDOMNodeId: 10,
        name: 'Search query',
        nodeId: 'ax-search',
        properties: [
          createAxProperty('focusable', true, 'boolean'),
          createAxProperty('editable', 'plaintext', 'token'),
        ],
        role: 'searchbox',
        value: '',
      }),
    ], [{
      attributes: { name: 'query', type: 'search' },
      backendDOMNodeId: 10,
      bounds: [0, 40, 240, 32],
      nodeName: 'INPUT',
    }])
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })

    const observation = await driver.observe(createObservationInput())

    expect(observation.elements).toEqual([{
      actions: ['fill', 'type'],
      frameId: 'main-frame',
      name: 'Search query',
      ref: 'e1',
      role: 'search-box',
      states: ['focusable', 'editable'],
      valueState: 'empty',
    }])
  })

  it('keeps the main-frame observation when a dynamic child frame disappears', async () => {
    const fixture = createFixture()
    const respond = fixture.respond
    fixture.sendCommand.mockImplementation(async (method, commandParams) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            childFrames: [{
              frame: {
                id: 'dynamic-frame',
                parentId: 'main-frame',
                url: 'https://ads.example.test/',
              },
            }],
            frame: {
              id: 'main-frame',
              url: 'https://example.com/checkout',
            },
          },
        }
      }
      if (
        method === 'Accessibility.getFullAXTree'
        && commandParams?.frameId === 'dynamic-frame'
      ) {
        throw new Error('Frame with the given id was not found')
      }
      return respond(method, commandParams)
    })
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })

    const observation = await driver.observe(createObservationInput())

    expect(observation.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Continue', role: 'button' }),
    ]))
    expect(observation.truncation?.reasons).toContain('frame-unavailable')
  })

  it('treats a target that can no longer be resolved as hidden', async () => {
    const fixture = createFixture(false, [
      createAxNode({
        backendDOMNodeId: 1,
        frameId: 'main-frame',
        name: 'Fixture',
        nodeId: 'ax-1',
        role: 'RootWebArea',
      }),
      createAxNode({
        backendDOMNodeId: 2,
        name: 'Loading',
        nodeId: 'ax-2',
        role: 'status',
      }),
    ], [{
      backendDOMNodeId: 2,
      bounds: [20, 20, 120, 32],
      text: 'Loading',
    }])
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })
    const observation = await driver.observe(createObservationInput())
    fixture.sendCommand.mockImplementation(async (method) => {
      if (method === 'DOM.resolveNode')
        throw new Error('No node with given id found')
      if (method === 'DOM.getBoxModel') {
        return {
          model: {
            border: [20, 20, 140, 20, 140, 52, 20, 52],
            content: [20, 20, 140, 20, 140, 52, 20, 52],
          },
        }
      }
      return fixture.respond(method)
    })

    await expect(driver.isTargetVisible({
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
      ref: 'e1',
    })).resolves.toBe(false)
    expect(fixture.sendCommand).not.toHaveBeenCalledWith(
      'DOM.getBoxModel',
      expect.anything(),
    )
  })

  it('keeps descendant refs scoped to their source frame', async () => {
    const fixture = createFixture()
    fixture.sendCommand.mockImplementation(async (method, commandParams) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            childFrames: [{
              frame: {
                id: 'checkout-frame',
                parentId: 'main-frame',
                url: 'https://payments.example.test/form',
              },
            }],
            frame: {
              id: 'main-frame',
              url: 'https://example.com/checkout',
            },
          },
        }
      }
      if (
        method === 'Accessibility.getFullAXTree'
        && commandParams?.frameId === 'checkout-frame'
      ) {
        return {
          nodes: [
            createAxNode({
              backendDOMNodeId: 20,
              frameId: 'checkout-frame',
              name: 'Payment form',
              nodeId: 'child-root',
              role: 'RootWebArea',
            }),
            createAxNode({
              backendDOMNodeId: 21,
              name: 'Pay now',
              nodeId: 'child-button',
              parentId: 'child-root',
              role: 'button',
            }),
          ],
        }
      }
      if (
        method === 'Accessibility.getFullAXTree'
        && commandParams?.frameId === 'main-frame'
      ) {
        return {
          nodes: [
            createAxNode({
              backendDOMNodeId: 1,
              frameId: 'main-frame',
              name: 'Fixture',
              nodeId: 'main-root',
              role: 'RootWebArea',
            }),
            createAxNode({
              backendDOMNodeId: 20,
              frameId: 'checkout-frame',
              name: 'Payment form',
              nodeId: 'child-root',
              parentId: 'main-root',
              role: 'RootWebArea',
            }),
            createAxNode({
              backendDOMNodeId: 21,
              name: 'Pay now',
              nodeId: 'child-button',
              parentId: 'child-root',
              role: 'button',
            }),
          ],
        }
      }
      return fixture.respond(method, commandParams)
    })
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })

    const observation = await driver.observe(createObservationInput())

    expect(observation.elements.find(element => element.name === 'Pay now'))
      .toMatchObject({ frameId: 'checkout-frame' })
    expect(observation.elements.filter(element => element.name === 'Pay now'))
      .toHaveLength(1)
    expect(fixture.sendCommand).toHaveBeenCalledWith(
      'Accessibility.getFullAXTree',
      { frameId: 'checkout-frame' },
    )
  })

  it('redacts password, OTP, token, payment values and URL secrets at the observation source', async () => {
    const nodes = [
      createAxNode({
        backendDOMNodeId: 10,
        name: 'Search',
        nodeId: 'ax-10',
        role: 'textbox',
        value: 'release notes',
      }),
      createAxNode({
        backendDOMNodeId: 11,
        name: 'Account entry',
        nodeId: 'ax-11',
        role: 'textbox',
        value: 'correct horse battery staple',
      }),
      createAxNode({
        backendDOMNodeId: 12,
        name: 'Code',
        nodeId: 'ax-12',
        role: 'textbox',
        value: '834921',
      }),
      createAxNode({
        backendDOMNodeId: 13,
        name: 'Developer value',
        nodeId: 'ax-13',
        role: 'textbox',
        value: 'token-private-value',
      }),
      createAxNode({
        backendDOMNodeId: 14,
        name: 'Billing number',
        nodeId: 'ax-14',
        role: 'textbox',
        value: '4111111111111111',
      }),
      createAxNode({
        backendDOMNodeId: 18,
        name: 'Empty verification code',
        nodeId: 'ax-18',
        role: 'textbox',
      }),
      createAxNode({
        backendDOMNodeId: 15,
        name: '834921',
        nodeId: 'ax-15',
        parentId: 'ax-12',
        properties: [createAxProperty('editable', 'plaintext', 'token')],
        role: 'StaticText',
      }),
      createAxNode({
        backendDOMNodeId: 16,
        name: 'token-private-value',
        nodeId: 'ax-16',
        parentId: 'ax-13',
        properties: [createAxProperty('editable', 'plaintext', 'token')],
        role: 'StaticText',
      }),
      createAxNode({
        backendDOMNodeId: 17,
        name: '4111111111111111',
        nodeId: 'ax-17',
        parentId: 'ax-14',
        properties: [createAxProperty('editable', 'plaintext', 'token')],
        role: 'StaticText',
      }),
    ]
    const fixture = createFixture(false, nodes, [
      {
        attributes: { name: 'search' },
        backendDOMNodeId: 10,
        bounds: [0, 40, 240, 32],
      },
      {
        attributes: { type: 'password' },
        backendDOMNodeId: 11,
        bounds: [0, 80, 240, 32],
      },
      {
        attributes: { autocomplete: 'one-time-code' },
        backendDOMNodeId: 12,
        bounds: [0, 120, 240, 32],
      },
      {
        attributes: { name: 'api_token' },
        backendDOMNodeId: 13,
        bounds: [0, 160, 240, 32],
      },
      {
        attributes: { autocomplete: 'cc-number' },
        backendDOMNodeId: 14,
        bounds: [0, 200, 240, 32],
      },
      {
        attributes: { autocomplete: 'one-time-code' },
        backendDOMNodeId: 18,
        bounds: [0, 240, 240, 32],
      },
    ])
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })

    const observation = await driver.observe({
      ...createObservationInput(),
      url: 'https://example.com/checkout?access_token=query-secret#otp-secret',
    })
    const elements = new Map(observation.elements.map(element => [element.name, element]))

    expect(elements.get('Search')).toMatchObject({
      actions: ['fill', 'type'],
      value: 'release notes',
      valueState: 'present',
    })
    for (const name of [
      'Account entry',
      'Code',
      'Developer value',
      'Billing number',
    ]) {
      expect(elements.get(name)).toMatchObject({
        actions: [],
        inputMode: 'human',
        valueState: 'redacted',
      })
      expect(elements.get(name)).not.toHaveProperty('value')
    }
    expect(elements.get('Empty verification code')).toMatchObject({
      actions: [],
      inputMode: 'human',
      valueState: 'empty',
    })
    expect(observation.url).toBe('https://example.com/checkout')
    expect(JSON.stringify(observation)).not.toMatch(
      /correct horse|834921|token-private-value|4111111111111111|query-secret|otp-secret/,
    )

    const accountEntry = elements.get('Account entry')!
    fixture.sendCommand.mockClear()
    await expect(driver.executeAction({
      action: { kind: 'fill', ref: accountEntry.ref, text: 'not-allowed' },
      documentRevision: observation.documentRevision,
      frameId: accountEntry.frameId,
      observationId: observation.observationId,
    })).rejects.toMatchObject({ code: 'BROWSER_HUMAN_INPUT_REQUIRED' })
    expect(fixture.sendCommand).not.toHaveBeenCalled()

    await expect(driver.executeAction({
      action: { key: 'Space', kind: 'press' },
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
    })).rejects.toMatchObject({ code: 'BROWSER_HUMAN_INPUT_REQUIRED' })
    expect(fixture.sendCommand).not.toHaveBeenCalled()
  })

  it('honors the requested element bound and marks additional semantic nodes truncated', async () => {
    const fixture = createFixture()
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      createScreenshotId: () => SCREENSHOT_ID,
      page: fixture.page,
    })

    const observation = await driver.observe({
      ...createObservationInput(),
      maxElements: 2,
    })

    expect(observation.elements.map(element => element.name)).toEqual([
      'Continue',
      'Email address',
    ])
    expect(observation.truncated).toBe(true)
    expect(observation.truncation).toEqual({
      reasons: ['element-limit'],
      suggestedMaxElements: 4,
    })
    expect(observation.screenshot).toEqual({
      byteLength: 10,
      height: 600,
      mimeType: 'image/png',
      reasons: ['semantic-content-truncated'],
      screenshotId: SCREENSHOT_ID,
      width: 800,
    })
    expect(fixture.capturePage).toHaveBeenCalledOnce()
    expect(JSON.stringify(observation)).not.toContain('iVBOR')

    expect(driver.resolveScreenshot({
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
      screenshotId: observation.screenshot!.screenshotId,
    })).toEqual({
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]),
      mimeType: 'image/png',
    })

    driver.invalidateDocument()
    expect(captureError(() => driver.resolveScreenshot({
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
      screenshotId: observation.screenshot!.screenshotId,
    }))).toEqual(expect.objectContaining({ code: 'BROWSER_TARGET_STALE' }))
  })

  it('does not let screenshot fallback bypass sensitive field redaction', async () => {
    const fixture = createFixture(false, [
      createAxNode({
        backendDOMNodeId: 10,
        name: 'Developer value',
        nodeId: 'ax-10',
        role: 'textbox',
        value: 'token-private-value',
      }),
      createAxNode({
        backendDOMNodeId: 11,
        name: 'Continue',
        nodeId: 'ax-11',
        role: 'button',
      }),
    ], [{
      attributes: { name: 'api_token' },
      backendDOMNodeId: 10,
      bounds: [0, 40, 240, 32],
    }])
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      createScreenshotId: () => SCREENSHOT_ID,
      page: fixture.page,
    })

    const observation = await driver.observe({
      ...createObservationInput(),
      maxElements: 1,
    })

    expect(observation).toMatchObject({
      elements: [{ valueState: 'redacted' }],
      truncated: true,
    })
    expect(observation).not.toHaveProperty('screenshot')
    expect(fixture.capturePage).not.toHaveBeenCalled()
  })

  it('truncates the complete UTF-8 observation before 32 KiB', async () => {
    const fixture = createFixture(false, Array.from({ length: 24 }, (_, index) => (
      createAxNode({
        backendDOMNodeId: index + 10,
        name: '界'.repeat(1_024),
        nodeId: `ax-${index + 10}`,
        role: 'StaticText',
      })
    )))
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })

    const observation = await driver.observe({
      ...createObservationInput(),
      maxElements: 400,
    })

    expect(serializedByteLength(observation)).toBeLessThanOrEqual(32 * 1_024)
    expect(observation.elements.length).toBeGreaterThan(0)
    expect(observation.elements.length).toBeLessThan(24)
    expect(observation.truncated).toBe(true)
    expect(observation.truncation).toEqual({ reasons: ['text-limit'] })
    expect(observation.screenshot?.reasons).toEqual([
      'semantic-content-truncated',
    ])
  })

  it('validates observation, frame, declared action, and live actionability before clicking', async () => {
    const fixture = createFixture()
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })
    const observation = await driver.observe(createObservationInput())
    configureActionCommands(fixture)

    await expect(driver.executeAction({
      action: { kind: 'click', ref: 'e1' },
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
    })).resolves.toBeUndefined()

    expect(fixture.sendCommand).toHaveBeenCalledWith('DOM.resolveNode', {
      backendNodeId: 4,
      objectGroup: 'lexora-browser-action',
    })
    expect(fixture.sendCommand).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({
        objectId: 'target-object',
        returnByValue: true,
      }),
    )
    expect(fixture.sendCommand).toHaveBeenCalledWith('DOM.scrollIntoViewIfNeeded', {
      backendNodeId: 4,
    })
    expect(fixture.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      button: 'left',
      clickCount: 1,
      type: 'mousePressed',
      x: 70,
      y: 36,
    })
    expect(fixture.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      button: 'left',
      clickCount: 1,
      type: 'mouseReleased',
      x: 70,
      y: 36,
    })
    expect(fixture.sendCommand).toHaveBeenCalledWith('Runtime.releaseObject', {
      objectId: 'target-object',
    })

    fixture.sendCommand.mockClear()
    await expect(driver.executeAction({
      action: { kind: 'click', ref: 'e1' },
      documentRevision: observation.documentRevision,
      frameId: 'other-frame',
      observationId: observation.observationId,
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
    await expect(driver.executeAction({
      action: { kind: 'fill', ref: 'e1', text: 'not allowed' },
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
    expect(fixture.sendCommand).not.toHaveBeenCalled()
  })

  it('fails closed before input dispatch when the observed target is no longer actionable', async () => {
    const fixture = createFixture()
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })
    const observation = await driver.observe(createObservationInput())
    configureActionCommands(fixture, { visible: false })

    await expect(driver.executeAction({
      action: { kind: 'click', ref: 'e1' },
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })

    expect(fixture.sendCommand).toHaveBeenCalledWith('Runtime.releaseObject', {
      objectId: 'target-object',
    })
    expect(fixture.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    )
  })

  it.each([
    [{ covered: true }, 'TARGET_COVERED'],
    [{ stable: false }, 'TARGET_UNSTABLE'],
  ] as const)(
    'returns a bounded reason before clicking an obstructed or moving target',
    async (actionability, reason) => {
      const fixture = createFixture()
      const driver = new SemanticBrowserDriver({
        createId: () => OBSERVATION_ID,
        page: fixture.page,
      })
      const observation = await driver.observe(createObservationInput())
      configureActionCommands(fixture, actionability)

      await expect(driver.executeAction({
        action: { kind: 'click', ref: 'e1' },
        documentRevision: observation.documentRevision,
        frameId: 'main-frame',
        observationId: observation.observationId,
      })).rejects.toMatchObject({
        code: 'BROWSER_TARGET_STALE',
        reason,
      })

      expect(fixture.sendCommand).not.toHaveBeenCalledWith(
        'Input.dispatchMouseEvent',
        expect.anything(),
      )
    },
  )

  it('rechecks live field sensitivity before dispatching input', async () => {
    const fixture = createFixture()
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      page: fixture.page,
    })
    const observation = await driver.observe(createObservationInput())
    const email = observation.elements.find(element => element.name === 'Email address')!
    configureActionCommands(fixture, {
      editable: true,
      fieldMetadata: {
        ariaLabel: 'One-time verification code',
        autocomplete: 'one-time-code',
        id: 'verification-code',
        label: 'Verification code',
        name: 'otp',
        placeholder: '123456',
        type: 'text',
      },
    })

    await expect(driver.executeAction({
      action: { kind: 'fill', ref: email.ref, text: 'must-not-be-dispatched' },
      documentRevision: observation.documentRevision,
      frameId: email.frameId,
      observationId: observation.observationId,
    })).rejects.toMatchObject({ code: 'BROWSER_HUMAN_INPUT_REQUIRED' })

    expect(fixture.sendCommand).not.toHaveBeenCalledWith(
      'Input.insertText',
      expect.anything(),
    )
  })

  it('invalidates every prior ref when the main document revision advances', async () => {
    const fixture = createFixture()
    const observationIds = [OBSERVATION_ID, SECOND_OBSERVATION_ID]
    const driver = new SemanticBrowserDriver({
      createId: () => observationIds.shift()!,
      page: fixture.page,
    })
    const previous = await driver.observe(createObservationInput())

    driver.invalidateDocument()

    expect(captureError(() => driver.resolveTarget({
      documentRevision: previous.documentRevision,
      observationId: previous.observationId,
      ref: 'e1',
    }))).toEqual(expect.objectContaining({ code: 'BROWSER_TARGET_STALE' }))
    await expect(driver.observe(createObservationInput())).resolves.toMatchObject({
      documentRevision: 1,
      observationId: SECOND_OBSERVATION_ID,
    })
  })

  it('expires observation refs after their short TTL', async () => {
    let now = 10_000
    const fixture = createFixture()
    const driver = new SemanticBrowserDriver({
      createId: () => OBSERVATION_ID,
      now: () => now,
      observationTtlMs: 1_000,
      page: fixture.page,
    })
    const observation = await driver.observe(createObservationInput())

    now += 1_000

    expect(captureError(() => driver.resolveTarget({
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
      ref: 'e1',
    }))).toEqual(expect.objectContaining({ code: 'BROWSER_TARGET_STALE' }))
  })

  it('evicts the oldest observation when the short registry reaches capacity', async () => {
    const fixture = createFixture()
    const observationIds = [
      OBSERVATION_ID,
      SECOND_OBSERVATION_ID,
      THIRD_OBSERVATION_ID,
    ]
    const driver = new SemanticBrowserDriver({
      createId: () => observationIds.shift()!,
      maxObservations: 2,
      page: fixture.page,
    })
    const first = await driver.observe(createObservationInput())
    const second = await driver.observe(createObservationInput())
    await driver.observe(createObservationInput())

    expect(captureError(() => driver.resolveTarget({
      documentRevision: first.documentRevision,
      observationId: first.observationId,
      ref: 'e1',
    }))).toEqual(expect.objectContaining({ code: 'BROWSER_TARGET_STALE' }))
    expect(driver.resolveTarget({
      documentRevision: second.documentRevision,
      observationId: second.observationId,
      ref: 'e1',
    })).toMatchObject({ backendDOMNodeId: 4 })
  })

  it('bounds cached screenshots by total bytes while keeping recent observations usable', async () => {
    const fixture = createFixture()
    const bytes = new Uint8Array(16 * 1024 * 1024)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    fixture.capturePage.mockResolvedValue({ getSize: () => ({ height: 600, width: 800 }), toPNG: () => bytes.slice() })
    const ids = [OBSERVATION_ID, SECOND_OBSERVATION_ID, THIRD_OBSERVATION_ID]
    const driver = new SemanticBrowserDriver({ page: fixture.page, createId: () => ids.shift()! })
    try {
      const first = await driver.observe({ ...createObservationInput(), maxElements: 2 })
      const second = await driver.observe({ ...createObservationInput(), maxElements: 2 })
      const third = await driver.observe({ ...createObservationInput(), maxElements: 2 })
      expect(() => driver.resolveScreenshot({ ...first, screenshotId: first.screenshot!.screenshotId }))
        .toThrow(expect.objectContaining({ code: 'BROWSER_TARGET_STALE' }))
      for (const observation of [second, third]) {
        expect(driver.resolveScreenshot({ ...observation, screenshotId: observation.screenshot!.screenshotId }).bytes.byteLength).toBe(bytes.byteLength)
        expect(driver.resolveTarget({ ...observation, ref: 'e1' })).toMatchObject({ backendDOMNodeId: 4 })
      }
    }
    finally { driver.dispose() }
  })

  it('rejects an observation finishing after disposal without retaining its screenshot', async () => {
    const fixture = createFixture()
    const pending = deferred<Awaited<ReturnType<typeof fixture.capturePage>>>()
    fixture.capturePage.mockReturnValue(pending.promise)
    const driver = new SemanticBrowserDriver({ page: fixture.page })
    const observing = driver.observe({ ...createObservationInput(), maxElements: 2 })
    const rejected = expect(observing).rejects.toMatchObject({ code: 'BROWSER_PAGE_FAILED' })
    await vi.waitFor(() => expect(fixture.capturePage).toHaveBeenCalledOnce())
    driver.dispose()
    pending.resolve({ getSize: () => ({ height: 600, width: 800 }), toPNG: () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) })
    await rejected
  })

  it('fails closed when CDP returns a malformed accessibility response', async () => {
    const fixture = createFixture()
    fixture.sendCommand.mockImplementation(async (method, commandParams) => (
      method === 'Accessibility.getFullAXTree'
        ? { nodes: 'not-an-array' }
        : fixture.respond(method, commandParams)
    ))
    const driver = new SemanticBrowserDriver({ page: fixture.page })

    await expect(driver.observe(createObservationInput())).rejects.toEqual(
      expect.objectContaining<Partial<SemanticBrowserDriverError>>({
        code: 'BROWSER_PAGE_FAILED',
        name: 'SemanticBrowserDriverError',
      }),
    )
  })

  it('detaches the debugger only when the driver attached it', async () => {
    const owned = createFixture()
    const ownedDriver = new SemanticBrowserDriver({ page: owned.page })
    await ownedDriver.observe(createObservationInput())
    ownedDriver.dispose()

    expect(owned.attach).toHaveBeenCalledExactlyOnceWith('1.3')
    expect(owned.detach).toHaveBeenCalledOnce()

    const shared = createFixture(true)
    const sharedDriver = new SemanticBrowserDriver({ page: shared.page })
    await sharedDriver.observe(createObservationInput())
    sharedDriver.dispose()

    expect(shared.attach).not.toHaveBeenCalled()
    expect(shared.detach).not.toHaveBeenCalled()
  })
})

function createObservationInput() {
  return {
    pageId: PAGE_ID,
    sessionId: SESSION_ID,
    status: 'ready' as const,
    title: 'Fixture',
    url: 'https://example.com/checkout',
  }
}

function captureError(operation: () => unknown): unknown {
  try {
    operation()
  }
  catch (error) {
    return error
  }
  throw new Error('Expected operation to fail')
}

function createFixture(
  initiallyAttached = false,
  nodes?: unknown[],
  layoutNodes: LayoutNodeFixture[] = [],
) {
  let isAttached = initiallyAttached
  const attach = vi.fn(() => {
    isAttached = true
  })
  const detach = vi.fn(() => {
    isAttached = false
  })
  const screenshotBytes = Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    1,
    2,
  ])
  const capturePage = vi.fn(async () => ({
    getSize: () => ({ height: 600, width: 800 }),
    toPNG: () => screenshotBytes,
  }))
  const respond = async (
    method: string,
    _commandParams?: Record<string, unknown>,
  ): Promise<unknown> => {
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: {
            id: 'main-frame',
            url: 'https://example.com/checkout',
          },
        },
      }
    }
    if (method === 'DOMSnapshot.captureSnapshot')
      return createDomSnapshot(layoutNodes)
    if (method === 'Page.getLayoutMetrics') {
      return {
        cssVisualViewport: {
          clientHeight: 600,
          clientWidth: 800,
          pageX: 0,
          pageY: 0,
        },
      }
    }
    if (method === 'DOM.getDocument') {
      return {
        root: {
          backendNodeId: 1,
          frameId: 'main-frame',
          localName: '',
          nodeId: 1,
          nodeName: '#document',
          nodeType: 9,
          nodeValue: '',
        },
      }
    }
    return {
      nodes: nodes ?? [
        createAxNode({
          backendDOMNodeId: 1,
          frameId: 'main-frame',
          name: 'Fixture',
          nodeId: 'ax-1',
          role: 'RootWebArea',
        }),
        createAxNode({
          backendDOMNodeId: 2,
          name: '  Checkout  ',
          nodeId: 'ax-2',
          properties: [createAxProperty('level', 2, 'integer')],
          role: 'heading',
        }),
        createAxNode({
          backendDOMNodeId: 3,
          ignored: true,
          name: 'Hidden instructions',
          nodeId: 'ax-3',
          role: 'StaticText',
        }),
        createAxNode({
          backendDOMNodeId: 4,
          name: 'Continue',
          nodeId: 'ax-4',
          properties: [createAxProperty('focusable', true, 'boolean')],
          role: 'button',
        }),
        createAxNode({
          backendDOMNodeId: 5,
          description: 'Used for the receipt',
          name: 'Email address',
          nodeId: 'ax-5',
          properties: [
            createAxProperty('focusable', true, 'boolean'),
            createAxProperty('required', true, 'boolean'),
            createAxProperty('editable', 'plaintext', 'token'),
          ],
          role: 'textbox',
          value: 'reader@example.com',
        }),
        createAxNode({
          backendDOMNodeId: 6,
          name: 'Email address',
          nodeId: 'ax-6',
          role: 'InlineTextBox',
        }),
        createAxNode({
          backendDOMNodeId: 7,
          name: '',
          nodeId: 'ax-7',
          role: 'generic',
        }),
      ],
    }
  }
  const sendCommand = vi.fn<(
    method: string,
    commandParams?: Record<string, unknown>,
  ) => Promise<unknown>>(respond)

  return {
    attach,
    detach,
    page: {
      capturePage,
      debugger: {
        attach,
        detach,
        isAttached: () => isAttached,
        sendCommand,
      },
    },
    capturePage,
    respond,
    sendCommand,
  }
}

function configureActionCommands(
  fixture: ReturnType<typeof createFixture>,
  actionability: Partial<{
    connected: boolean
    covered: boolean
    disabled: boolean
    editable: boolean
    fieldMetadata: {
      ariaLabel: string
      autocomplete: string
      id: string
      label: string
      name: string
      placeholder: string
      type: string
    }
    focusable: boolean
    readOnly: boolean
    selectable: boolean
    stable: boolean
    visible: boolean
  }> = {},
): void {
  fixture.sendCommand.mockImplementation(async (method) => {
    if (method === 'DOM.resolveNode') {
      return {
        object: {
          objectId: 'target-object',
          type: 'object',
        },
      }
    }
    if (method === 'Runtime.callFunctionOn') {
      return {
        result: {
          type: 'object',
          value: {
            connected: true,
            covered: false,
            disabled: false,
            editable: false,
            fieldMetadata: {
              ariaLabel: '',
              autocomplete: '',
              id: '',
              label: '',
              name: '',
              placeholder: '',
              type: '',
            },
            focusable: true,
            readOnly: false,
            selectable: false,
            stable: true,
            visible: true,
            ...actionability,
          },
        },
      }
    }
    if (method === 'DOM.getBoxModel') {
      return {
        model: {
          border: [10, 20, 130, 20, 130, 52, 10, 52],
          content: [10, 20, 130, 20, 130, 52, 10, 52],
        },
      }
    }
    return {}
  })
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function createAxNode(input: {
  backendDOMNodeId: number
  description?: string
  frameId?: string
  ignored?: boolean
  name: string
  nodeId: string
  parentId?: string
  properties?: unknown[]
  role: string
  value?: string
}) {
  return {
    backendDOMNodeId: input.backendDOMNodeId,
    description: input.description
      ? { type: 'string', value: input.description }
      : undefined,
    frameId: input.frameId,
    ignored: input.ignored ?? false,
    name: { type: 'computedString', value: input.name },
    nodeId: input.nodeId,
    parentId: input.parentId,
    properties: input.properties ?? [],
    role: { type: 'role', value: input.role },
    value: input.value !== undefined
      ? { type: 'string', value: input.value }
      : undefined,
  }
}

function createDomSnapshot(nodes: LayoutNodeFixture[]) {
  const strings = ['main-frame']
  const stringIndexes = new Map(strings.map((value, index) => [value, index]))
  const getStringIndex = (value: string) => {
    const existing = stringIndexes.get(value)
    if (existing !== undefined)
      return existing
    const index = strings.length
    strings.push(value)
    stringIndexes.set(value, index)
    return index
  }

  return {
    documents: [{
      frameId: 0,
      layout: {
        bounds: nodes.map(node => node.bounds),
        nodeIndex: nodes.map((_, index) => index),
        text: nodes.map(node => getStringIndex(node.text ?? '')),
      },
      nodes: {
        attributes: nodes.map(node => Object.entries(node.attributes ?? {})
          .flatMap(([name, value]) => [getStringIndex(name), getStringIndex(value)])),
        backendNodeId: nodes.map(node => node.backendDOMNodeId),
        nodeName: nodes.map(node => getStringIndex(node.nodeName ?? 'DIV')),
      },
    }],
    strings,
  }
}

function createAxProperty(name: string, value: unknown, type: string) {
  return { name, value: { type, value } }
}
