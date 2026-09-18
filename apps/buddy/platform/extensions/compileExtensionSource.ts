import type { ExtensionManifest } from '../../shared/extensions/extensionManifest'
import { posix } from 'node:path'
import ts from 'typescript'
import { extensionPathSchema } from '../../shared/extensions/extensionManifest.ts'

export type ExtensionCompiler = (files: Map<string, Uint8Array>, manifest: ExtensionManifest, signal: AbortSignal, report: (message: string) => void) => Promise<Map<string, Uint8Array>>
const outputPath = (path: string) => path.replace(/\.(?:ts|mts)$/, '.js')

export function compileExtensionSource(files: Map<string, Uint8Array>, manifest: ExtensionManifest, report: (message: string) => void): Map<string, Uint8Array> {
  const output = new Map<string, Uint8Array>()
  const text = new TextDecoder('utf-8', { fatal: true })
  const encode = new TextEncoder()
  const names = new Set<string>()
  for (const name of files.keys()) {
    if (/\.d\.[cm]?ts$/.test(name))
      continue
    const destination = outputPath(name)
    if (names.has(destination.toLowerCase()))
      throw new Error('EXTENSION_SOURCE_OUTPUT_COLLISION')
    names.add(destination.toLowerCase())
  }
  function resolveImport(importer: string, value: string): string {
    if (!value.startsWith('./') && !value.startsWith('../'))
      throw new Error('EXTENSION_SOURCE_IMPORT_DENIED')
    const path = posix.normalize(posix.join(posix.dirname(importer), value))
    if (!extensionPathSchema.safeParse(path).success)
      throw new Error('EXTENSION_SOURCE_IMPORT_DENIED')
    const target = [path, `${path}.ts`, `${path}.js`, `${path}/index.ts`, `${path}/index.js`, path.replace(/\.js$/, '.ts')].find(next => files.has(next) && /\.(?:[cm]?js|[cm]?ts)$/.test(next) && !/\.d\.[cm]?ts$/.test(next))
    if (!target)
      throw new Error('EXTENSION_SOURCE_IMPORT_MISSING')
    const relative = posix.relative(posix.dirname(outputPath(importer)), outputPath(target))
    return relative.startsWith('.') ? relative : `./${relative}`
  }
  for (const [name, bytes] of files) {
    if (/\.d\.[cm]?ts$/.test(name) || name === 'extension.json')
      continue
    if (!/\.(?:js|mjs|ts|mts)$/.test(name)) {
      output.set(name, bytes)
      continue
    }
    report(name)
    const compiled = ts.transpileModule(text.decode(bytes), {
      fileName: name,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true, verbatimModuleSyntax: true, sourceMap: false, declaration: false, removeComments: true },
    })
    const errors = compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? []
    if (errors.length) {
      for (const error of errors.slice(0, 10)) {
        const location = error.file?.getLineAndCharacterOfPosition(error.start ?? 0)
        report(`${name}:${(location?.line ?? 0) + 1}:${(location?.character ?? 0) + 1} TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ').slice(0, 400)}`)
      }
      throw new Error('EXTENSION_SOURCE_COMPILE_FAILED')
    }
    const source = ts.createSourceFile(outputPath(name), compiled.outputText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
    const transformed = ts.transform(source, [context => (root) => {
      const visit: ts.Visitor = (node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          if (!ts.isStringLiteral(node.moduleSpecifier))
            throw new Error('EXTENSION_SOURCE_IMPORT_DENIED')
          const specifier = ts.factory.createStringLiteral(resolveImport(name, node.moduleSpecifier.text))
          return ts.isImportDeclaration(node)
            ? ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, specifier, node.attributes)
            : ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, specifier, node.attributes)
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const [argument] = node.arguments
          if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument))
            throw new Error('EXTENSION_SOURCE_IMPORT_DENIED')
          return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [ts.factory.createStringLiteral(resolveImport(name, argument.text))])
        }
        return ts.visitEachChild(node, visit, context)
      }
      return ts.visitNode(root, visit) as ts.SourceFile
    }])
    try {
      output.set(outputPath(name), encode.encode(ts.createPrinter().printFile(transformed.transformed[0]!)))
    }
    finally {
      transformed.dispose()
    }
  }
  const compiledManifest: ExtensionManifest = { ...manifest, format: 'compiled', ...(manifest.entry ? { entry: outputPath(manifest.entry) } : {}), contributes: { ...manifest.contributes, views: manifest.contributes.views.map(view => ({ ...view, entry: outputPath(view.entry) })) } }
  output.set('extension.json', encode.encode(JSON.stringify(compiledManifest)))
  return output
}
