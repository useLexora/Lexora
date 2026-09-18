import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const buddyRoot = fileURLToPath(new URL('../', import.meta.url))
const rendererRoot = path.join(buddyRoot, 'src')
const aliases = {
  '@/': rendererRoot,
  '@buddy-shared/': path.join(buddyRoot, 'shared'),
  '@buddy-electron/': path.join(buddyRoot, 'electron'),
  '@buddy-tests/': path.join(buddyRoot, '__tests__'),
}
const foundationLayers = new Set(['shared', 'platform', 'i18n', 'theme'])
const modelForbiddenLayers = new Set(['state', 'widgets', 'pages', 'layouts', 'components', 'editor'])
const stateForbiddenLayers = new Set(['widgets', 'pages', 'layouts', 'components', 'editor'])
const publicEntry = /^(?:index|contracts|ui|routes)(?:\.[cm]?[jt]s)?$/

function partsWithin(root, filename) {
  const relative = path.relative(root, filename)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null
  return relative.split(path.sep)
}

function resolveImport(filename, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0]
  for (const [alias, root] of Object.entries(aliases)) {
    if (clean.startsWith(alias))
      return path.resolve(root, clean.slice(alias.length))
  }
  if (clean.startsWith('.') || path.isAbsolute(clean))
    return path.resolve(path.dirname(filename), clean)
  return null
}

function staticSpecifier(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0].value.cooked
  return null
}

function isTypeOnly(node) {
  if (node.importKind === 'type' || node.exportKind === 'type' || node.type === 'TSImportType')
    return true
  return node.specifiers?.length > 0
    && node.specifiers.every(specifier => specifier.importKind === 'type' || specifier.exportKind === 'type')
}

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      moduleToApp: '业务模块不能依赖 app；通过模块 Context、props 或 action 接收应用能力。',
      foundationToBusiness: '{{layer}} 不能反向依赖 app 或 modules；将业务逻辑归回所属模块。',
      privateModule: '外部只能通过 {{module}} 的 index、contracts、ui 或 routes 公共入口使用模块。',
      modelToPresentation: 'model 不能依赖 {{layer}}；将纯类型和计算归入 model，将交互或状态逻辑移出 model。',
      modelRuntime: 'model 不能运行时依赖 {{dependency}}；Vue 和编辑器类型使用 import type。',
      stateToPresentation: 'state 不能依赖展示层 {{dependency}}；业务状态与公共类型归 state/model，DOM 和编辑器交互归 widget。',
      sharedHost: 'apps/buddy/shared 是无宿主依赖的领域契约，不能依赖 {{dependency}}。',
      platformToHost: 'apps/buddy/platform 是进程共用的底层实现，不能反向依赖 {{dependency}}。',
      workbenchToBusiness: 'workbench 通过注册表接收业务贡献，不能依赖 app 或 modules。',
      workbenchCoreHost: 'workbench common/services 不依赖 UI 或宿主，通过接口注入能力。',
    },
  },
  create(context) {
    const filename = context.physicalFilename
    const source = partsWithin(buddyRoot, filename)
    if (!source || source.includes('__tests__'))
      return {}
    const renderer = partsWithin(rendererRoot, filename)
    const module = renderer?.[0] === 'modules' ? renderer[1] : null
    const model = module && renderer.slice(2, -1).includes('model')
    const state = module && renderer.slice(2, -1).includes('state')

    function check(node, sourceNode) {
      const specifier = staticSpecifier(sourceNode)
      if (!specifier)
        return
      const resolved = resolveImport(filename, specifier)
      const target = resolved ? partsWithin(buddyRoot, resolved) : null
      const targetRenderer = resolved ? partsWithin(rendererRoot, resolved) : null
      const targetModule = targetRenderer?.[0] === 'modules' ? targetRenderer[1] : null
      const report = (messageId, data) => context.report({ node: sourceNode, messageId, data })

      if (source[0] === 'shared' && (
        specifier.startsWith('node:')
        || isBuiltin(specifier)
        || specifier === 'electron'
        || specifier.startsWith('electron/')
        || ['platform', 'service', 'electron', 'src'].includes(target?.[0])
      )) {
        report('sharedHost', { dependency: specifier })
        return
      }
      if (source[0] === 'platform' && (
        ['src', 'electron', 'service'].includes(target?.[0])
        || specifier === 'electron'
        || specifier.startsWith('electron/')
      )) {
        report('platformToHost', { dependency: specifier })
        return
      }
      if (!renderer)
        return
      if (renderer[0] === 'workbench') {
        if (['app', 'modules'].includes(targetRenderer?.[0])) {
          report('workbenchToBusiness')
          return
        }
        if (['common', 'services'].includes(renderer[1]) && (
          ['vue', 'vue-router', 'naive-ui', 'electron'].includes(specifier)
          || isBuiltin(specifier)
          || ['electron', 'service', 'platform'].includes(target?.[0])
          || (targetRenderer?.[0] === 'workbench' && targetRenderer[1] === 'browser')
          || ['app', 'modules', 'platform', 'theme', 'i18n'].includes(targetRenderer?.[0])
          || targetRenderer?.includes('ui')
        )) {
          report('workbenchCoreHost')
          return
        }
      }
      if (module && targetRenderer?.[0] === 'app') {
        report('moduleToApp')
        return
      }
      if (foundationLayers.has(renderer[0]) && ['app', 'modules'].includes(targetRenderer?.[0])) {
        report('foundationToBusiness', { layer: renderer[0] })
        return
      }
      if (model) {
        const layer = targetModule && (
          targetRenderer.slice(2).find(part => modelForbiddenLayers.has(part))
          || /^(?:ui|routes)(?:\.[cm]?[jt]s)?$/.exec(targetRenderer[2])?.[0]
        )
        if (layer) {
          report('modelToPresentation', { layer })
          return
        }
        if (!isTypeOnly(node) && (
          /^(?:vue|@vue\/[^/]+|naive-ui)(?:\/|$)/.test(specifier)
          || specifier.startsWith('@tiptap/')
        )) {
          report('modelRuntime', { dependency: specifier })
          return
        }
      }
      if (targetModule && module !== targetModule) {
        const entry = targetRenderer.slice(2)
        if (entry.length > 1 || (entry.length === 1 && !publicEntry.test(entry[0]))) {
          report('privateModule', { module: targetModule })
          return
        }
      }
      if (state && targetRenderer && (
        targetRenderer.some(part => stateForbiddenLayers.has(part))
        || resolved.endsWith('.vue')
        || (targetModule && /^(?:ui|routes)(?:\.[cm]?[jt]s)?$/.test(targetRenderer[2]))
      )) {
        report('stateToPresentation', { dependency: specifier })
      }
    }

    return {
      ImportDeclaration: node => check(node, node.source),
      ExportNamedDeclaration: node => node.source && check(node, node.source),
      ExportAllDeclaration: node => check(node, node.source),
      ImportExpression: node => check(node, node.source),
      TSImportType: node => check(node, node.source),
      TSExternalModuleReference: node => check(node, node.expression),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          check(node, node.arguments[0])
      },
    }
  },
}
