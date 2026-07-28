import { AppShell } from '../components/AppShell';
import { LibraryScreen } from '../components/LibraryScreen';

/** screen-library — design/handoff/README.md:14. Replaces the M0 token-pipeline scaffold page. */
export default function Page() {
  return (
    <AppShell>
      <LibraryScreen />
    </AppShell>
  );
}
