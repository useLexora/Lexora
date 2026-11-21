import type { Component } from 'vue'
import { Add20Regular, ArrowLeft20Regular, ArrowUp20Regular, Checkmark20Regular, ChevronDown20Regular, Dismiss20Regular, HandLeft20Regular, LockClosed20Regular, LockOpen20Regular, MoreHorizontal20Regular, Search20Regular, ShieldTask20Regular } from '@vicons/fluent'
import { h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { buddyIconEyes, buddyIconPaths, buddyToolbarStroke } from '../shared/ui/icon/buddyIcon'
import { panelResizeIcon } from '../shared/ui/icon/panelResizeIcon'

function resizeIcon(data: string) {
  return { width: panelResizeIcon.size, height: panelResizeIcon.size, paths: [{ data, strokeWidth: panelResizeIcon.strokeWidth }] }
}

async function fluentIcon(component: Component) {
  const svg = await renderToString(h(component))
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  const paths = [...svg.matchAll(/<path\s[^>]*d="([^"]+)"[^>]*>/g)].map(match => ({ data: match[1] }))
  if (!viewBox || !paths.length || /<(?:circle|rect|ellipse|polygon|polyline|line)\b/.test(svg))
    throw new Error('Native icons require a path-based SVG')
  return { width: Number(viewBox[1]), height: Number(viewBox[2]), paths }
}

export async function nativeIcons() {
  return {
    back: await fluentIcon(ArrowLeft20Regular),
    more: await fluentIcon(MoreHorizontal20Regular),
    check: await fluentIcon(Checkmark20Regular),
    close: await fluentIcon(Dismiss20Regular),
    search: await fluentIcon(Search20Regular),
    add: await fluentIcon(Add20Regular),
    arrowUp: await fluentIcon(ArrowUp20Regular),
    chevronDown: await fluentIcon(ChevronDown20Regular),
    maximize: resizeIcon(panelResizeIcon.maximize),
    minimize: resizeIcon(panelResizeIcon.minimize),
    readOnly: await fluentIcon(LockClosed20Regular),
    manualApproval: await fluentIcon(HandLeft20Regular),
    smartApproval: await fluentIcon(ShieldTask20Regular),
    fullAccess: await fluentIcon(LockOpen20Regular),
    partners: {
      width: 24,
      height: 24,
      paths: [
        ...buddyIconPaths.map(data => ({ data, strokeWidth: buddyToolbarStroke })),
        ...buddyIconEyes.map(([x, y]) => ({ data: `M${x - 0.85} ${y}a.85.85 0 1 0 1.7 0a.85.85 0 1 0-1.7 0` })),
      ],
    },
  }
}
