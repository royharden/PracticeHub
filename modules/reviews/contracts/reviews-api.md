---
doc_id: reviews-api
title: "reviews API — FROZEN contract (WP-073)"
status: frozen
depends_on: [tenancy-types]
---

# Reviews API (FROZEN)

Frozen by WP-073. Invites, public responses, and private PHI holds live in
`modules/reviews`.

1. An invite is sentiment-blind. `sentimentScore` does not select send or skip.
   Eligibility does. A `sentiment-at-least` gate is denied and stores nothing.
2. A public response is attributed to a visit, a location, and a provider.
3. A response that contains PHI is refused as a public reply and held privately.
4. The review-invite source is the named placeholder `WP-044`
   (`fixtures/WP-044.placeholder.json`) until that package replaces it.

Schema: `modules/reviews/migrations/0067-wp073-reviews.sql`.
