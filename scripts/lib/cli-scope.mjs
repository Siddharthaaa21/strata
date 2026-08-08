// How a local CLI gets a `Scope`.
//
// One function, shared by `ingest` and `search`, and it is the SAME path the MCP server uses:
// present a token, have it verified against the database, receive a scope. There is no CLI-shaped
// shortcut, because a shortcut is a second way to mint authority and the second way is the one
// nobody tests until it is the one running.
//
// This replaces `localDevScope`, which was a labelled stub that fabricated a scope from an
// environment variable. It was honest about what it was and it still had to go: a function that
// mints authority without a credential is indistinguishable, at the call site, from one that
// checks a credential — so every call site had to be trusted rather than verified.
//
// The workspace comes from the TOKEN, not from `STRATA_WORKSPACE_ID`. Two sources of truth that
// must agree can disagree, and the one that loses is always the one the operator was looking at.

import { createAuthenticator } from '@strata/auth';
import { createAuthStore } from '@strata/storage';

const SETUP_HINT = [
  'STRATA_CLI_TOKEN is not set.',
  '',
  'The CLIs authenticate like every other caller — there is no anonymous mode and no',
  'development stub. Mint a token for yourself:',
  '',
  '  npm run agent:create -- "Local CLI" --kind service --by <your member email>',
  '',
  'then put the printed STRATA_CLI_TOKEN=... line in .env.',
  '',
  'If no member has signed in yet, `npm run member -- add <email>` and sign in once first.',
].join('\n');

/**
 * Verifies `STRATA_CLI_TOKEN` and returns a request scope.
 *
 * Exits rather than throwing: these are operator commands, and a stack trace is a worse answer to
 * "you have no credential" than a sentence saying so.
 */
export async function cliScope(db) {
  const token = process.env['STRATA_CLI_TOKEN'];
  if (!token) {
    console.error(SETUP_HINT);
    process.exit(1);
  }

  try {
    return await createAuthenticator(createAuthStore(db)).scopeFromAgentToken(token);
  } catch (e) {
    // Every failure reason collapses to one message on the wire (ADR 0006), but this is an operator
    // at a terminal, not a caller over a network — the distinction is exactly what they need to fix
    // it, and there is nobody here to probe an oracle.
    const kind = e && typeof e === 'object' && 'kind' in e ? e.kind : 'unknown';
    console.error(`STRATA_CLI_TOKEN rejected: ${kind}`);
    if (kind === 'revoked') {
      console.error('Mint a replacement with `npm run agent:create`. Revocation is immediate.');
    } else if (kind === 'malformed') {
      console.error('Expected the full stra_at_<id>_<secret> string as printed by agent:create.');
    }
    process.exit(1);
  }
}
