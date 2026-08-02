import { loadLibrary } from '../lib/vault';
import { LibraryView } from './LibraryView';

/**
 * screen-library — design/handoff/README.md:14-19.
 *
 * A Server Component: the database is reached here, and only a scoped, flat projection crosses to
 * the client. Fixtures are retired (D8's fixture-driven pass is over) — this reads the real vault.
 */
export async function LibraryScreen() {
  const { docs, sources } = await loadLibrary();
  return <LibraryView docs={docs} sources={sources} />;
}
