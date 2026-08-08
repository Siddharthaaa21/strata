---
id: comp-sidebar
kind: component
title: Sidebar / nav shell
status: done
owner: web
spec: design/handoff/README.md:33
depends_on: [tokens-color, tokens-type, dec-stack]
---

248px fixed on desktop; on mobile a full-screen fixed overlay behind a hamburger, with a top bar
taking its place. Active nav item gets a white pill, ink text, and an accent leading dot.
Shared by all three screens, so build it before any of them.

**Search field** (Vault.dc.html:52) — a GET form targeting `/?q=`, so the query is a URL and the
ranked search runs on the SERVER across the whole vault ([[svc-search]]). Deliberately not a
controlled input filtering the loaded page: that would search one clamped page of 50 and report
"nothing matches" for documents that are in the vault. See [[screen-library]].

It was absent from M2 to M7. Deferred when nothing backed it, then never picked up after M4 built
the search — because the deferral lived as a note inside an already-checked milestone bullet, which
is not somewhere anything gets read again. Recorded in [[dec-deferral-tracking]].

**Still absent, and now tracked rather than noted:** the folders list (Vault.dc.html:66-77) and the
user-profile footer (Vault.dc.html:79-82). The folder pills on [[screen-library]] already provide
folder filtering, so the sidebar list duplicates an affordance rather than restoring a missing one;
the profile footer needs a `User` contract that does not exist, and its handoff copy is placeholder.

**Nav items carry a `built` flag, and Agent Access is `false`.** It linked to `/agent-access` — a
route that does not exist — and returned a 404 from primary navigation. Everything else in the app
already declares its own state: `Connect` / `Upload` on [[screen-import]] carry `aria-disabled`, and
"Ask agent about this" on [[screen-reader]] is a real disabled button (R8). This was the one control
that lied, and a 404 reads as a *broken* app rather than an unfinished one — a much worse message
than the honest one.

It renders as a greyed `<span>`, not a `Link` with a guard: a link that cannot be followed is still
a link to a keyboard, a screen reader, and a middle click, so the element itself has to be the thing
that is not navigable. The item stays in the list rather than being deleted — three nav items is the
handoff's information architecture, and dropping one to hide unfinished work is drift that would
have to be undone. Flip the flag when [[screen-agent-access]] lands; nothing else changes.
