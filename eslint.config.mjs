import nextConfig from 'eslint-config-next';

const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'coverage/**',
      'next-env.d.ts',
    ],
  },
  ...nextConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-console': 'error',
    },
  },
];

export default config;