import { AppShell } from '../components/AppShell';
import { LibraryScreen } from '../components/LibraryScreen';

/**
 * Rendered per request, never prerendered.
 *
 * `pg` queries are not `fetch`, so nothing here opts this route into dynamic rendering on its own —
 * and `next build` duly marked it `○ (Static)`, baking one snapshot of the vault into HTML. Two
 * consequences, both real: the Library would never show a newly ingested document without a
 * rebuild, and once M7 makes the workspace per-user, a statically prerendered page would serve the
 * build machine's workspace to every visitor.
 *
 * This is declared on the route rather than fixed by adding a dynamic API inside the loader,
 * because the reason is a property of the page — its content is per-request user data — not an
 * implementation detail of how the data happens to be fetched today.
 */
export const dynamic = 'force-dynamic';

/** screen-library — design/handoff/README.md:14. Replaces the M0 token-pipeline scaffold page. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[]; folder?: string | string[] }>;
}) {
  const { q, page, folder } = await searchParams;
  // A repeated `?q=a&q=b` arrives as an array. Taking the first is arbitrary but total; passing an
  // array through would reach `websearch_to_tsquery` as "a,b" and quietly search for something the
  // user never typed.
  const query = Array.isArray(q) ? q[0] : q;
  const folderParam = Array.isArray(folder) ? folder[0] : folder;
  // `Number('')` is 0 and `Number('abc')` is NaN — both are clamped to a real page by `loadLibrary`
  // against the true count, so `?page=0`, `?page=abc` and `?page=999` all render a real page rather
  // than an empty grid indistinguishable from an empty workspace.
  const pageParam = Number(Array.isArray(page) ? page[0] : (page ?? '1'));

  return (
    <AppShell>
      <LibraryScreen query={query} page={pageParam} folder={folderParam} />
    </AppShell>
  );
}
