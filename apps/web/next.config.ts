import type { NextConfig } from 'next';
import { clientEnv } from './src/lib/root-env.ts';

const config: NextConfig = {
  // `NEXT_PUBLIC_*` is substituted into the client bundle while it is BUILT, and Next only reads
  // `.env*` from this directory — ours is at the repo root. Without this the server saw the values
  // and the browser did not, so every redirect and every query worked while the sign-in button
  // threw "not set" on click. See src/lib/root-env.ts; the list of names is fixed there, not here.
  env: clientEnv(),

  // Workspace packages ship TypeScript source, not build output — every one this app can reach at
  // runtime must be listed. `@strata/auth` and `@strata/storage` were missing while `vault.ts`
  // imported both; it worked only because npm workspace hoisting put them where the bundler happened
  // to look. A pruned production install does not hoist that way.
  transpilePackages: ['@strata/core', '@strata/tokens', '@strata/auth', '@strata/storage', '@strata/ingest'],
};

export default config;
