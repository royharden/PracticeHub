# Referral API (WP-074, M24)

Status: frozen at the `simulated` ceiling. Source of truth: `src/contracts.ts`, `src/loop.ts`,
`src/aging.ts`, `src/directory.ts`. Requirements: REQ-REF-005, -006, -011, -013, -014, -015.

## Loop

Stages move forward only: `created → sent → acknowledged → scheduled → seen → results-returned →
reviewed → closed`. A fax-only partner may skip stages. Holds (`consent-required`,
`mn-written-consent-required`, `send-failed`, `patient-follow-up`, `missing-information`) pause a
loop without closing it.

## Closure invariants

| Closure reason | Evidence required |
|---|---|
| `results-reviewed` | finalized consult note matched to referral, patient and tenant; review by the currently assigned reviewer |
| `declined-by-destination` | a partner `declined` event; the referrer is told the reason |
| `no-results-after-outer-bound` | 45 days since send, one documented outreach, an escalation to the referring clinician |
| `patient-non-engagement` | open patient follow-up hold, two documented attempts, referrer told; never for an urgent referral |

An appointment, a transport receipt or an elapsed timer never closes a loop. A destination decline
closes a loop only before results are returned (`DECLINE_AFTER_RESULTS` afterwards). No records leave
before consent for that disclosure is current. Consent must name the referral's tenant, patient and
recipient, and an unparseable expiry is no consent. A Minnesota record (state codes are matched
case-insensitively) also needs written consent. Every instant is parsed fail-closed:
an unparseable one is `INVALID_INSTANT`, never a satisfied clock. A directory slice with a duplicate
NPI is refused (`DIRECTORY_DUPLICATE`).
Every send is logged as a disclosure (recipient, consent reference, channel, transmission, artifacts).

## Directory

`fixtures/nppes-slice.v1.json` is a synthetic slice shaped like NPPES rows. `DIRECTORY_PIN` holds its version
and the SHA-256 of its canonical JSON (keys sorted, no whitespace). A mismatch refuses the load. A new
slice ships as a new version with a new pin. Every case records the directory version it was opened
against. A directory entry is contact data only and never stands for acceptance of care.

## Rails and placeholders

| Surface | Today | Replaced by |
|---|---|---|
| Outbound fax | `createFaxSim` (module double of `OutboundChannelPort`) | outbound half of `sims/fax-sim` (WP-024 rail family) |
| ESP (electronic specialist portal) | `createEspSim` (module double) | an esp-sim rail; no package owns it yet |
| Consult notes | `wp060PlaceholderPort` + `fixtures/wp-060-consult-notes.json` | WP-060 clinical contracts v2 |
| Records packet storage | `wp024PlaceholderBlobs` | WP-024 `BlobStore` port |

`referral tables` (persistence) are not in this package. The engine is pure and store-agnostic.
