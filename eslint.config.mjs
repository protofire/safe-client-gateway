import globals from 'globals';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const SAFE_DEPLOYMENTS_IMPORT = {
  name: '@safe-global/safe-deployments',
  message: 'Please import from @/domain/common/utils/deployments instead.',
};

// Gateway code the org layer (cgw-org) may import. Every new coupling to the
// gateway is an explicit change here, reviewed like an API dependency.
const ORG_GATEWAY_IMPORTS = [
  '@/config/configuration.service.interface',
  '@/datasources/cache/cache.module',
  '@/datasources/network/network.service.interface',
  '@/domain/common/entities/log-type.entity',
  '@/domain/common/utils/deployments',
  '@/domain/common/utils/safe',
  '@/domain/common/utils/simulate-tx-accessor',
  '@/domain/errors/data-source.error',
  '@/domain/interfaces/blockchain-api.manager.interface',
  '@/domain/interfaces/cache-readiness.interface',
  '@/domain/interfaces/transaction-api.manager.interface',
  '@/logging/logging.interface',
  '@/modules/balances/balances.module',
  '@/modules/balances/domain/balances.repository.interface',
  '@/modules/blockchain/blockchain.module',
  '@/modules/chains/chains.module',
  '@/modules/chains/domain/chains.repository.interface',
  '@/modules/csv-export/csv-utils/csv.service',
  '@/modules/csv-export/v1/datasources/export-api.manager.interface',
  '@/modules/csv-export/v1/entities/csv-export.options',
  '@/modules/csv-export/v1/entities/transaction-export.entity',
  '@/modules/delegate/domain/v2/delegates.v2.repository.interface',
  '@/modules/health/routes/entities/health.entity',
  '@/modules/hooks/routes/entities/event-type.entity',
  '@/modules/hooks/routes/entities/event.entity',
  '@/modules/hooks/routes/entities/schemas/event.schema',
  '@/modules/safe/domain/entities/__tests__/erc20-transfer.builder',
  '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder',
  '@/modules/safe/domain/entities/multisig-transaction.entity',
  '@/modules/safe/domain/entities/operation.entity',
  '@/modules/safe/domain/entities/safe.entity',
  '@/modules/safe/domain/entities/transfer.entity',
  '@/modules/safe/domain/safe.repository.interface',
  '@/org-app.module',
  '@/org-main',
  '@/org-migrate',
  '@/routes/common/filters/global-error.filter',
  '@/routes/common/filters/zod-error.filter',
  '@/validation/pipes/validation.pipe',
];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'warn',
        { assertionStyle: 'as' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'warn',
      'no-nested-ternary': 'error',
      '@typescript-eslint/array-type': [
        'error',
        {
          default: 'generic',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [SAFE_DEPLOYMENTS_IMPORT],
        },
      ],
      // TODO: Address these rules: (added to update to ESLint 9)
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Added after typescript-eslint 8.1.0
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-deprecated': 'warn',
    },
  },
  {
    files: ['src/modules/org/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [SAFE_DEPLOYMENTS_IMPORT],
          patterns: [
            {
              regex: `^@/(?!(?:modules|config)/org(?:/|$))(?!(?:${ORG_GATEWAY_IMPORTS.map((p) => escapeRegex(p.slice(2))).join('|')})$)`,
              message:
                'Gateway import not on the org allowlist: add it to ORG_GATEWAY_IMPORTS in eslint.config.mjs if the coupling is intended.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
