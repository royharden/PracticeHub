---
doc_id: reviews-api
title: "reviews API — FROZEN contract (WP-073)"
status: frozen
depends_on: [tenancy-types]
---

# Reviews API (FROZEN)

Frozen by WP-073; revised by WP-073 rework 1. Invites, public responses, and
private PHI holds live in `modules/reviews`.

1. An invite is sentiment-blind. `InviteRequest` carries only objective
   inputs (tenant, invite reference, visit/location/provider attribution and
   the upstream `eligible` decision). It has no sentiment, satisfaction,
   complaint or gating field, and `planInvite` reads nothing else a caller
   attaches, so identical eligible requests yield identical invites whatever
   sentiment accompanies them (REQ-REP-001 AC2, REQ-REP-005).
2. A public response is attributed to a visit, a location, and a provider.
3. No reply publishes automatically. `submitResponse` never publishes: a
   response in which the `detectPhi` pre-screen finds any PHI class (SSN,
   phone, email, date, record identifier, birth date, person name, clinical
   term) is held privately with the classes found, and every other response
   waits as `pending-approval`. The only publish path is `approveResponse`,
   which records the approving human (`approvedBy`) and the instant
   (`approvedAt`); a held reply can never be approved. (Integrator decision,
   Roy-delegated: additions/decision-targeted-fix.md.)
4. A response reference is used once per tenant, across public replies and
   holds: an identical resubmission returns the same outcome, a divergent one
   is refused with `RESPONSE_CONFLICT`.
5. The module is the authoritative PHI gate. The `review_response.body`
   CHECK in the migration is a narrower defence-in-depth subset.
6. The review-invite source is the named placeholder `WP-044`
   (`fixtures/WP-044.placeholder.json`) until that package replaces it.

Schema: `modules/reviews/migrations/0067-wp073-reviews.sql`.
