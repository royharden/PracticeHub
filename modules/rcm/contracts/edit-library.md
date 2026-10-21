---
doc_id: edit-library
title: 'RCM edit library — versioned NCCI, MUE, and LCD/NCD packs'
date: 2026-09-25
package_id: WP-084
module: M20
status: frozen
---

# Edit library (WP-084)

The local module evaluates synthetic, versioned NCCI, MUE, and LCD/NCD rule packs. It does not author licensed billing content or establish a payer-approved coding convention.

## Packs and effective version selection

A `RulePack` contains `packId`, `family`, `version`, `effectiveOn`, optional inclusive `effectiveThrough`, and `edits`. `family` is `NCCI | MUE | LCD-NCD`. `selectRulePack` selects the latest family version whose start is on or before the service date, then checks that version's end. If that latest version has ended, it returns null rather than falling back to an older superseded version. Two versions of one family with the same start are refused.

`applyRulePacks` selects the applicable version per family and line service date. Produced edits cite their family, version, pack identifier, edit identifier, line identifier, and code. A line outside its selected pack's date window produces no edit from that pack.

## NCCI, MUE, and legacy behavior

For a paired NCCI edit with `column2Code`, the edit is attached to the column-2 line when a column-1 partner exists on the same service date. Indicator `0` does not allow a modifier bypass; indicator `1` bypasses for a recognized `59`, `XE`, `XS`, `XP`, or `XU` on the column-2 line; indicator `9` produces no paired edit. A missing indicator takes the current `0` behavior. Recognizing modifiers only on column 2 is observed implementation behavior pending NR-124's RCM-lead confirmation, not an agent-approved billing rule.

MUE units are aggregated across lines sharing code and service date; exceeding `maxUnits` produces the group result with its line identifiers and unit total. LCD/NCD and the retained code-level edit form match per line. The code-level NCCI fallback without `column2Code` remains for the WP-086 synthetic code `99999` fixture; retiring it is separate work.

`applyRulePack` is deprecated. With `RulePackContext`, it checks whether the pack is in force on the context date; supersession checks use only the versions supplied in `context.versions` and can refuse with `RULE_PACK_SUPERSEDED`. If `versions` is omitted or incomplete, supplying context does not establish selection of the latest version. Without context it retains the legacy single-pack behavior: it checks that pack's own date window but does not enforce selection against newer versions. `applyRulePacks` is the version-selecting path. The optional-context compatibility hole remains visible; this documentation change neither removes the export nor makes context mandatory.

## Stored regression corpus

`regressRulePack` checks that every baseline edit identity `(family, editId, lineId, code)` remains in the candidate. `runEditRegressionCorpus` requires a stored baseline for every pack/case pair, compares each actual edit set with that baseline, and checks successive family versions for dropped edits. Each case is evaluated on the pack's own effective start so date windows do not hide an edit. An intended retirement is recorded explicitly with its source/destination packs, case, edit, and reason; unrecorded drops fail the corpus.

## Fee-schedule freshness

`monitorFeeScheduleFreshness` compares local and reference snapshots for the same payer. It reports stale local loads, publication order in either direction, rates above or below reference beyond tolerance, and codes missing on either side. It raises alarms; it never corrects a rate. Invalid snapshots or limits are refused.

`DEFAULT_FRESHNESS_POLICY` currently uses `maxAgeDays: 90` and `toleranceMinor: 0`. These are synthetic defaults awaiting the RCM lead's confirmation. Documenting them is not policy approval.

## Integration and owner decisions

The WP-040, WP-056, WP-062, and WP-066 placeholders remain. Real rule ingestion, licensed content, persistence, and package wiring require their own evidence. NR-124 and freshness-default decisions remain with the RCM lead. RCM-wide AI-governance confirmation (NR-125), COB/MSP confirmations (NR-160/161), payer deposit sequencing (H-20/NR-162/163), and WP-092 gate-identifier confirmation remain open under their named owners; this contract supplies no human signature or activation approval.
