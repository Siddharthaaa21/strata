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
export default function Page() {
  return (
    <AppShell>
      <LibraryScreen />
    </AppShell>
  );
}
