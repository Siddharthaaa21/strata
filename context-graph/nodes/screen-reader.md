---
id: screen-reader
kind: screen
title: Document Reader
status: done
owner: web
spec: design/handoff/README.md:27
depends_on: [contract-doc, comp-sidebar, tokens-color, tokens-type]
---

660px content column plus a 280px right rail that becomes a footer section below 860px. Body type
grows on mobile (18.5px/1.85 vs 17.5px/1.75). The "Ask agent about this" CTA opens an interactive
in-browser document assistant (`DocAssistant.tsx`) powered by streaming completions and safe
prompt fencing (`apps/web/src/app/api/doc-chat/route.ts`).


**Inline tokenizer extraction (M7R3):** `apps/web/src/components/markdown-inline.ts` separates the inline Markdown tokenizer from `MarkdownBody.tsx` so it can be tested. Node's type stripping does not transform JSX, leaving `.tsx` code unreachable by `node --test`; a ReDoS defect was introduced, fixed wrongly, and caught only by external review. Plain `.ts` with its own suite makes the guarantee assertable. ReDoS fixed via bounded quantifiers (`{0,500}` and `{0,2000}` instead of `*`) plus per-render budget. A previous attempt capped each CALL at 20k, allowing a 2 MiB payload chunked into 105 lines to walk straight past it (25.8 seconds). Budget is per-render, combined with bounded quantifiers; worst case is about 200k × 500 codepoints regardless of shape. The async Server Component runs during SSR and blocks every concurrent request—a threat model the prior fix misunderstood.
