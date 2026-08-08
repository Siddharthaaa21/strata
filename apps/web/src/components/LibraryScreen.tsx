import { loadLibrary } from '../lib/vault';
import { LibraryView } from './LibraryView';

/**
 * screen-library — design/handoff/README.md:14-19.
 *
 * A Server Component: the database is reached here, and only a scoped, flat projection crosses to
 * the client. Fixtures are retired (D8's fixture-driven pass is over) — this reads the real vault.
 */
export async function LibraryScreen({ query }: { query?: string | undefined }) {
  const { docs, sources, total, folders, query: q } = await loadLibrary(query);
  // `key` remounts the view when the query changes, which resets the folder pill. Without it the
  // pill selected while browsing survives into a search and silently narrows the results — so a
  // search that genuinely matched would render as "nothing found" because the one hit sat in a
  // different folder than the pill left active.
  return (
    <LibraryView
      key={q}
      docs={docs}
      sources={sources}
      total={total}
      folders={folders}
      query={q}
    />
  );
}
