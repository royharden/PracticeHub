---
doc_id: edit-library
title: 'RCM edit library — versioned NCCI, MUE, and LCD/NCD packs'
date: 2026-09-25
package_id: WP-084
module: M20
status: frozen
---

# Edit library (WP-084)

A rule pack is `{ packId, family, version, effectiveOn, edits }`. `family` is `NCCI`, `MUE`, or `LCD-NCD`. `effectiveOn` is `YYYY-MM-DD`. A line before that date produces no edit.

`applyRulePack` returns edits that cite `family`, `version`, and `packId`. An MUE edit fires when units exceed `maxUnits`. An NCCI or LCD/NCD edit fires when the code matches.

`regressRulePack` compares a candidate run to a baseline. It fails when any baseline edit identity (`family`, `editId`, `lineId`, `code`) is absent from the candidate. The result lists those dropped edits.

The WP-040, WP-056, WP-062, and WP-066 placeholders stay in place.
