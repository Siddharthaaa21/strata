import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source, not build output.
  transpilePackages: ['@strata/core', '@strata/tokens'],
};

export default config;
