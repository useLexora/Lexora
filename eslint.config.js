import antfu from '@antfu/eslint-config'
import buddyDependencyBoundaries from './apps/buddy/eslint/dependency-boundaries.js'

export default antfu({
  pnpm: {
    catalogs: false,
  },
  vue: true,
}, {
  ignores: [
    '**/.output/**',
    '**/native/target/**',
    '**/native-pet/target/**',
  ],
}, {
  files: ['apps/buddy/{src,shared,platform}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}'],
  plugins: {
    buddy: {
      rules: {
        'dependency-boundaries': buddyDependencyBoundaries,
      },
    },
  },
  rules: {
    'buddy/dependency-boundaries': 'error',
  },
}, {
  files: ['**/*.{js,mjs,cjs,jsx}'],
  rules: {
    'unused-imports/no-unused-vars': 'off',
  },
}, {
  files: ['.playwright/scripts/**/*.{mjs,cjs,js}'],
  rules: {
    'unicorn/filename-case': ['error', { case: 'kebabCase', checkDirectories: false }],
  },
}, {
  files: ['apps/api/src/**/*.ts'],
  rules: {
    'ts/consistent-type-imports': 'off',
  },
}, {
  files: ['apps/web/src/**/*.{ts,vue}'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{
        name: '@haohaoxue/lexora-contracts',
        allowTypeImports: true,
        message: '运行时契约值请使用领域子入口，类型继续使用 import type。',
      }, {
        name: '@haohaoxue/lexora-shared',
        allowTypeImports: true,
        message: 'shared 函数请使用具体子入口，避免根 barrel 扩大首包。',
      }, {
        name: 'element-plus',
        allowTypeImports: true,
        message: 'Element Plus 运行时请使用自动导入、@/utils/element-plus 或具体子入口，类型继续使用 import type。',
      }],
    }],
  },
}, {
  files: ['packages/shared/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{
        name: '@haohaoxue/lexora-contracts',
        allowTypeImports: true,
        message: 'shared 包内运行时契约值请使用 contracts 领域子入口，类型继续使用 import type。',
      }],
    }],
  },
})
