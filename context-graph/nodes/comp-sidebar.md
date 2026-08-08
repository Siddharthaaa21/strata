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
