// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { browserSurfaceOccluded } from '../browserSurfaceOcclusion'

const clip = { x: 300.5, y: 80, width: 500, height: 300 }
function rect(element: HTMLElement, x: number, width: number) {
  element.getBoundingClientRect = () => new DOMRect(x, 0, width, 600)
}
afterEach(() => document.body.replaceChildren())

it('keeps the live page visible while the splitter and its pointer shield overlap the page', () => {
  const workbench = document.createElement('section')
  workbench.className = 'workbench is-resizing'
  const splitter = document.createElement('div')
  splitter.setAttribute('role', 'separator')
  splitter.style.zIndex = '11'
  rect(splitter, 300, 1)
  const shield = document.createElement('div')
  shield.className = 'workbench__resize-shield'
  rect(shield, 0, 1000)
  workbench.append(splitter, shield)
  document.body.append(workbench)
  expect(browserSurfaceOccluded(clip)).toBe(false)
})

it('blocks the page behind a modal even outside its dialog and blocks a menu only where it overlaps', () => {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'menu')
  document.body.append(overlay)
  rect(overlay, 280, 21)
  expect(browserSurfaceOccluded(clip)).toBe(true)
  rect(overlay, 100, 50)
  expect(browserSurfaceOccluded(clip)).toBe(false)
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  expect(browserSurfaceOccluded(clip)).toBe(true)
  overlay.style.visibility = 'hidden'
  expect(browserSurfaceOccluded(clip)).toBe(false)
})
