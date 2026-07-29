/**
 * Reader metadata line date ("Jul 18, 2026" in Vault.dc.html:154). Like `relativeTime`, this is a
 * render concern computed from the stored ISO-8601 `Doc.updatedAt` — nothing is persisted here.
 */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}
