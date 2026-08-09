import { relativeTime } from '../lib/relative-time';
import { loadActivity, loadAgentAccess } from '../lib/vault';
import { RevokeButton } from './RevokeButton';
import styles from './AgentAccessScreen.module.css';

/**
 * screen-agent-access — M7 increment 3. **No handoff design exists** (see the CSS module).
 *
 * The milestone's closing condition is "a user can see and revoke what each connected agent can
 * reach." Every part of that has worked from a terminal since increment 1; this screen is the part
 * a teammate can use. `mcp:smoke` already proves the property it promises — a revoked token stops
 * working on the next call, same connection, no restart.
 *
 * TWO RULES SHAPE EVERY LINE HERE.
 *
 * 1. **No credential material.** `last4` and nothing else: not the hash, not the token id, not the
 *    presented string. The screen exists so someone can decide whether a credential should keep
 *    existing, and that decision needs a name, a reach, and a last-used — none of which authenticate
 *    anything. A management UI that can display a secret is a way to leak one over a shoulder.
 *
 * 2. **Reach is stated in words, and the three cases stay distinct.** A grant with `sourceIds`
 *    NULL reaches every source; `[]` reaches none; a list reaches those. Collapsing NULL to `[]`
 *    anywhere — the `?? []` that looks like defensive coding — renders the most powerful credential
 *    in the workspace as the most harmless one.
 */
export async function AgentAccessScreen() {
  const [{ agents }, activity] = await Promise.all([loadAgentAccess(), loadActivity()]);
  const active = agents.filter((a) => a.revokedAt === undefined);
  const revoked = agents.filter((a) => a.revokedAt !== undefined);

  return (
    <div className={styles.screen}>
      <div>
        <h1 className={`serif ${styles.title}`}>Agent Access</h1>
        <p className={styles.subtitle}>
          Credentials that can read this workspace over MCP, and exactly what each one reaches.
          Revoking takes effect immediately — the next call an agent makes fails, with no restart
          and no waiting for a cache to expire.
        </p>
      </div>

      <div>
        <h2 className={styles.sectionLabel}>Connected</h2>
        {active.length === 0 ? (
          <div className={styles.empty}>
            No agents have access. Mint one with{' '}
            <span className={styles.code}>npm run agent:create -- &quot;Name&quot; --kind service --by you@example.com</span>.
            The token is printed once and never stored.
          </div>
        ) : (
          <div className={styles.list}>
            {active.map((a) => (
              <Agent key={a.principalId} agent={a} />
            ))}
          </div>
        )}
      </div>

      {revoked.length > 0 && (
        <div>
          <h2 className={styles.sectionLabel}>Revoked</h2>
          {/*
            Revoked agents STAY on the screen. Removing the row would answer "did that actually
            work?" by deleting the evidence, and that is the one question this screen has to answer
            well — D16's lesson about revocation reporting, in the UI rather than in a CLI.
          */}
          <div className={styles.list}>
            {revoked.map((a) => (
              <Agent key={a.principalId} agent={a} />
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className={styles.sectionLabel}>Recent activity</h2>

        {/*
          ADR 0005 §5's compensating control, finally reaching a human. The ADR admits in its own
          Open items that fencing reduces injection's likelihood and blast radius without
          eliminating it, and names logging as what covers the remainder — so an injection that
          SUCCEEDS is discovered here or not at all. Collected since M6, read by nobody until now.
        */}
        {activity.unattributedFailures > 0 && (
          <p className={styles.warning}>
            {activity.unattributedFailures} call{activity.unattributedFailures === 1 ? '' : 's'} in
            the last {activity.windowDays} days failed to authenticate at all. A few is ordinary — a
            stream is what a credential being probed looks like. These cannot be attributed to a
            workspace or an agent, so they are counted rather than listed.
          </p>
        )}

        {activity.events.length === 0 ? (
          <div className={styles.empty}>
            No agent has called this workspace in the last {activity.windowDays} days.
          </div>
        ) : (
          <div className={styles.activity}>
            {activity.events.map((e) => (
              <div key={e.id} className={styles.event}>
                <span className={styles.eventTime}>{relativeTime(e.at)}</span>
                {e.actor === undefined ? (
                  // A call that authenticated as nobody, or as a principal that no longer exists.
                  // Shown as unknown rather than as a raw id: the id means nothing to a reader.
                  <span className={styles.eventAnon}>unknown</span>
                ) : (
                  <span className={styles.eventActor}>{e.actor}</span>
                )}
                <span className={styles.eventTool}>{e.tool}</span>
                <span className={e.outcome === 'ok' ? styles.eventOutcome : styles.eventFailed}>
                  {/*
                    A COUNT of documents, never their ids or titles. The log's first rule is that it
                    never holds content; a view that resolved logged doc ids back to titles would
                    reconstruct — inside the screen built for incident response — precisely what the
                    table refuses to store.
                  */}
                  {e.outcome === 'ok'
                    ? `${e.documents} document${e.documents === 1 ? '' : 's'}`
                    : e.outcome}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Agent({ agent }: { agent: Awaited<ReturnType<typeof loadAgentAccess>>['agents'][number] }) {
  const revoked = agent.revokedAt !== undefined;
  // `sourceIds === undefined` is the unnarrowed case, and it is the fact most worth noticing here.
  const unnarrowed = agent.sourceIds === undefined;

  return (
    <div className={`${styles.agent} ${revoked ? styles.agentRevoked : ''}`}>
      <div className={styles.agentHead}>
        <span className={styles.name}>{agent.name}</span>
        <span className={styles.kind}>{revoked ? 'revoked' : agent.kind}</span>
      </div>

      <div className={styles.facts}>
        <Fact label="Reaches">
          <span className={unnarrowed && !revoked ? styles.factWide : styles.factValue}>{agent.reach}</span>
        </Fact>

        <Fact label="Last used">
          {/* "Never" is not a formatting fallback, it is a finding: an agent that has never called
              is one nobody would miss, and it is the easiest thing on this screen to revoke. */}
          <span className={styles.factValue}>
            {agent.lastUsedAt === undefined ? 'Never' : relativeTime(agent.lastUsedAt)}
          </span>
        </Fact>

        <Fact label="Created">
          <span className={styles.factValue}>
            {relativeTime(agent.createdAt)}
            {agent.createdBy === undefined ? ' · owner unrecorded' : ` by ${agent.createdBy}`}
          </span>
        </Fact>

        {agent.last4.length > 0 && (
          <Fact label="Tokens">
            <span className={styles.factValue}>
              {agent.last4.map((l) => (
                <span key={l} className={styles.code}>
                  …{l}
                </span>
              ))}
            </span>
          </Fact>
        )}
      </div>

      {revoked ? (
        <p className={styles.note}>Revoked {relativeTime(agent.revokedAt!)}. Its tokens no longer authenticate.</p>
      ) : (
        <RevokeButton principalId={agent.principalId} name={agent.name} />
      )}

      {/* An agent whose creator was never recorded cannot be swept up by removing that person —
          the exact gap `--by` was made mandatory to close (D16). Saying so on the row is the only
          place an operator would ever find out. */}
      {!revoked && agent.createdBy === undefined && (
        <p className={styles.note}>
          No creator recorded, so removing a member will not revoke this agent. Revoke it here.
        </p>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      {children}
    </div>
  );
}
