/**
 * The one place that decides whether a caller-supplied string may be used as a redirect target.
 *
 * This check existed three times -- in `/auth/callback`, in `/auth/dev-login`, and in `vault.ts`'s
 * `?next=` builder -- each written by hand, each a line or two, each correct. Three correct copies
 * of a security check is a countdown: the fourth call site copies whichever one it happened to read,
 * and the first one relaxed is the one that matters.
 *
 * WHY THIS IS A SECURITY CHECK. The auth routes are exactly where an open redirect gets used,
 * because the domain in the address bar is genuinely ours right up to the moment it is not. A link
 * to `ourapp.com/auth/callback?next=//evil.example` reads as ours, and lands somewhere else with the
 * user primed to type a password.
 *
 * Deliberately free of `server-only` and of every import, so `node --test` can load it. A check that
 * the test runner cannot reach will eventually be wrong (D15).
 */

/**
 * Whether the string contains a control character.
 *
 * A character-code scan rather than a regular expression, for two reasons that both bit here. A
 * literal control character in the source is a NUL byte in the repository — `git diff` then treats
 * the file as binary and hides every future change from review, which is why this repo has a
 * `nul-scan` in the gate and a hook on top of it. Writing the escapes into a `RegExp` avoids that
 * but trips `no-control-regex`, a rule worth keeping rather than suppressing. Comparing numbers
 * has neither problem and says plainly what it means.
 *
 * CR and LF are the ones that matter: in a `Location` header they split one response into two.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A same-origin path, or `undefined` if the input cannot be trusted as one.
 *
 * Rejects, and each of these is a real bypass rather than a hypothetical one:
 *
 *   - anything not starting `/` -- an absolute URL, obviously
 *   - `//host` -- PROTOCOL-RELATIVE, which is absolute. `//evil.example` is a different site, and
 *     this is the bypass that survives a naive `startsWith('/')` check
 *   - `/\evil.example` -- browsers normalise backslashes to forward slashes, so this is
 *     `//evil.example` wearing a hat
 *   - a control character -- request splitting, and CR/LF in a `Location` header is how one response
 *     becomes two
 *
 * `undefined` rather than a thrown error or a silent fallback: the caller decides what "nowhere in
 * particular" means, and for every current caller that is the workspace root.
 */
export function safeInternalPath(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (!raw.startsWith('/')) return undefined;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return undefined;
  if (hasControlCharacter(raw)) return undefined;
  return raw;
}

/**
 * The paths that must never be a post-sign-in destination.
 *
 * Sending someone back to the sign-in form after signing in is a loop wearing the costume of a
 * redirect, and `/auth/*` targets re-enter a flow that has already completed.
 */
export function isAuthPath(path: string): boolean {
  return path === '/login' || path.startsWith('/login?') || path.startsWith('/auth/');
}

/**
 * A destination to carry through a sign-in, or `undefined` if there is nothing worth carrying.
 *
 * Stricter than `safeInternalPath` on purpose: this one also refuses the auth screens and the root,
 * because carrying `next=/` adds a parameter that changes nothing.
 */
export function redirectTarget(raw: string | null | undefined): string | undefined {
  const path = safeInternalPath(raw);
  if (path === undefined || path === '/' || isAuthPath(path)) return undefined;
  return path;
}
