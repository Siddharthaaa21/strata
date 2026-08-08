import { AppShell } from '../../components/AppShell';
import { AgentAccessScreen } from '../../components/AgentAccessScreen';

/**
 * Per request, never prerendered — same reasoning as the Library and Import routes, and more
 * sharply here: a cached render of this page is a list of live credentials that stops updating
 * when one is revoked, which is the exact thing it must never do.
 */
export const dynamic = 'force-dynamic';

/** screen-agent-access — M7 increment 3. No handoff design exists; see the component. */
export default function Page() {
  return (
    <AppShell>
      <AgentAccessScreen />
    </AppShell>
  );
}
