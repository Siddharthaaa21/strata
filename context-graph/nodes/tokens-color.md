---
id: tokens-color
kind: token
title: Color tokens
status: planned
owner: design
spec: design/handoff/README.md:48
depends_on: []
---

Every OKLCH value in Strata, transcribed from the handoff into packages/tokens. Three distinct
border values (88%, 89%, 91%) do three different jobs and are not interchangeable. Accent is a
prop with a default, not a constant. Inverse text is `oklch(99% 0.005 90)`, not white.
