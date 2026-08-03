import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source, not build output — every one this app can reach at
  // runtime must be listed. `@strata/auth` and `@strata/storage` were missing while `vault.ts`
  // imported both; it worked only because npm workspace hoisting put them where the bundler happened
  // to look. A pruned production install does not hoist that way.
  transpilePackages: ['@strata/core', '@strata/tokens', '@strata/auth', '@strata/storage'],
};

export default config;
