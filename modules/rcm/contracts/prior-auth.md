---
doc_id: prior-auth
title: 'RCM prior authorization and medication continuity'
date: 2026-09-25
package_id: WP-082
module: M20
status: frozen
---

# Prior authorization and medication continuity (WP-082)

The module consumes eligibility and medication inputs through the existing WP-081/WP-066 boundaries. It does not establish a live prior-authorization rail or an eRx dependency. Medication fixtures remain at `modules/rcm/fixtures/wp-066-medication.json`.

## Requirement lookup and authorization decisions

`lookupRequirement` matches rules by tenant, payer, service code, and service date. The requirement vocabulary is `none | prior-auth | referral | both`, with `unknown` when no applicable rule can be resolved. Overlapping rules that disagree collect every demanded authorization kind and flag the lookup as ambiguous; a disagreement is not silently treated as no authorization required.

`checkAuthorization` checks a positive integer unit request against records of the required kind matching tenant, patient, payer, and service. A usable record is approved, covers the service date inclusively, and has enough remaining units (or unlimited units when `unitsApproved` is null). The decision returns `clear`, `blocked`, or `hold`, with reasons, rule-version references, and satisfying authorization references.

An invalid relevant rule date produces an unknown-requirement hold. Malformed record dates are not used in string comparisons: where no usable record satisfies the kind and malformed matching records exist, the decision holds unless another kind is definitely unmet. Definite missing, pending, denied, expired, not-yet-valid, cancelled, or exhausted-unit conditions carry the corresponding reason and can block. Approvals before and after a service date that cover neither side of that date yield `<kind>-not-valid-on-service-date`. Ambiguous rule resolution remains a hold even when records otherwise satisfy it.

`consumeAuthorizationUnits` accepts a positive integer quantity on an approved record and refuses exceeding a non-null approved-unit limit. It returns an updated record. This function alone is not persistence or a transactional concurrency guarantee.

## Continuity clock and acknowledgement

`continuityGapDays` is `nextFillInDays - daysOfSupplyRemaining`; the current threshold is 3 days. Unacknowledged gaps greater than that threshold can advance `open` to `covering-prescriber`, then to `medical-director`.

`escalateContinuity` requires a `ContinuityClock` at runtime; omitting it throws `CONTINUITY_CLOCK`, although the TypeScript parameter remains optional for compatibility. An alert opened without `openedAt` starts its clock on the first clocked escalation call and does not immediately escalate. Thereafter a call advances one level only when that level's SLA has elapsed. Current synthetic defaults are 240 minutes at `open` and 240 minutes at `covering-prescriber`; callers can supply a `ContinuitySla`.

Escalation refuses a mismatched acting tenant. An acknowledged alert, a gap at or below threshold, or the terminal escalation level does not escalate further. A supplied event sink receives the escalation event. `acknowledgeContinuityAlert` records the named actor/time and tenant-scoped acknowledgement. These behaviors do not approve a clinical SLA or close shared strict-instant parsing work.

## Interim and native clauses

`honorInterimClauses` retains a clause with a non-empty `interimSource` and names that source in `honored`. A clause without such a source is retained in `native` when `nativeRule` is true; otherwise its identifier is listed in `dropped`. Native clauses are not silently lost.

## Remaining boundaries

Prior-authorization tables, external rule ingestion, real rail wiring, and integration/persistence proofs remain separate work. The compatibility signature and any older comments describing unclocked one-step escalation do not restore that removed runtime behavior. Synthetic fixtures, current capability ceilings, and named human approvals remain unchanged.
