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
  {
    // Operator CLIs in scripts/ print for the human running them rather than for a
    // request path, so console output is intentional there.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

export default config;
