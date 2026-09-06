---
id: comp-connector-row
kind: component
title: Connector row
status: done
owner: web
spec: design/handoff/README.md:23
depends_on: [contract-source, tokens-color, dec-stack]
---

Flat row, 12px radius: 36px tinted initials tile, name + one-line description, right-aligned action
as bare colored text with no button chrome. GitHub ships not connected by default — a product
decision, not an oversight.

**Two kinds of action, and the difference is visible (D24).** `markdown` and `claude` render a real
`<button>` (`ConnectorAction.tsx`, a client component) that opens a file picker and calls a Server
Action. Everything else renders an `aria-disabled` `<span>` — deliberately not a `<button>`, because
an inert control that reports itself as a button to a screen reader invites the click it cannot
honour, and not styled with `cursor: pointer`, which is the smallest available lie.

A live action is always `accent.default`, never `statusColor.connected`. Green is this screen's
vocabulary for STATE; `Import` and `Upload` are things you do, and a green verb reads as an action
that already happened.

There is **no error colour token** — the handoff draws no error state anywhere — so the failure line
reuses `--source-claude-fg`, the same value the sign-in form already uses. Inventing an OKLCH value
here would be exactly the from-memory hardcoding CLAUDE.md forbids; reusing the one precedent keeps
the decision in a single place if a real token is ever added. See [[screen-import]], [[tokens-color]].
