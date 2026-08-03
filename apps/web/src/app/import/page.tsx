import { AppShell } from '../../components/AppShell';
import { ImportScreen } from '../../components/ImportScreen';

/** Per request, never prerendered — same reasoning as the Library route. */
export const dynamic = 'force-dynamic';

/** screen-import — design/handoff/README.md:20. */
export default function Page() {
  return (
    <AppShell>
      <ImportScreen />
    </AppShell>
  );
}
