import { expect, it } from 'vitest'
import { extensionCompatibilityIssue, extensionUpgradeSuggested } from '../extensionCompatibility'
import { extensionMetadataSchema } from '../extensionManifest'

it.each([
  ['>=0.11.0 <1.0.0', 3, 1, 'app-too-old', true],
  ['<0.10.0', 3, 1, 'app-too-new', false],
  ['<0.10.0 || >=0.11.0', 3, 1, 'app-version-unsupported', false],
  ['*', 5, 1, 'api-unsupported', true],
  ['*', 4, 1, null, false],
  ['*', 3, 2, 'format-unsupported', true],
  ['*', 3, 1, null, false],
] as const)('classifies range %s, API %i and format %i without suggesting an upgrade for other causes', (range, apiVersion, schemaVersion, reason, upgrade) => {
  const metadata = extensionMetadataSchema.parse({ schemaVersion, id: 'tests.compatibility', name: 'Compatibility', version: '1.0.0', apiVersion, engines: { lexora: range } })
  const issue = extensionCompatibilityIssue(metadata, '0.10.1')
  expect(issue?.reason ?? null).toBe(reason)
  expect(issue ? extensionUpgradeSuggested(issue) : false).toBe(upgrade)
})
