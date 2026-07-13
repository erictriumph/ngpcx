# Privacy Backlog

Future work arising from the 2026-07-13 privacy and data governance audit. Not a
policy document — a practical list, organized by urgency.

## Immediate

- [x] **Recurring cleanup of expired records.** `sessions`, `auth_sessions`, and
  `oauth_states` were only purged once, at server startup — a real gap between
  deploys where logically-expired rows sat on disk. Now re-run every 6 hours by
  `server.js` via `db.cleanupExpiredRecords()` (same SQL as the existing startup
  cleanup, not duplicated). **Implemented.**

## Before Public Launch

- [ ] Publish the privacy page (`public/privacy.html`) — built, not yet reviewed
  or announced.
- [ ] Review the privacy page's wording end-to-end against the live app one more
  time before launch, in case anything drifts between now and then.
- [ ] Verify retention behavior in production — confirm the 6-hour cleanup
  interval is actually firing on the deployed instance (log line or manual
  DB check), not just locally.

## Near-term

- [ ] User-initiated deletion capability, in general — no self-service deletion
  exists today for any user data.
- [ ] Community submission deletion — let a contributor (anonymous or signed in)
  remove their own finding. Identity resolution for this already exists on the
  read path (`GET /api/community/mine`); a scoped delete is the natural next
  step, not a redesign.
- [ ] Researcher request note deletion/withdrawal — the optional free-text note
  submitted with a Researcher volunteer request (`researcher_requests.note`)
  has no self-service deletion path, same gap as community submissions above.
  `POST /api/researcher/withdraw` exists server-side (sets the request to
  `withdrawn`) but doesn't clear the note text itself.
- [ ] Account deletion — a way to remove a `users` row (and decide what happens
  to their attributed community submissions) without a manual SQL statement.
- [ ] Recurring privacy review — revisit this backlog and the audit's findings
  periodically, not just once.

## Future Consideration

- [ ] Data export — a portable export of everything tied to a user's identity.
  Non-trivial: deciding whether an export includes scan sessions a user has
  touched means first deciding whether to build an identity↔inventory link
  that deliberately doesn't exist today (see audit, Cross-Linking Risk).
- [ ] Anonymization strategy — no de-identification path exists in either
  direction; only anonymous→authenticated migration is built.
- [ ] Formal retention policy — a real policy decision, not just an engineering
  default, especially for `community_submissions` (arguably near-permanent,
  since it's the compatibility database's core value) versus `unknown_apps`
  (aggregate, unlinked to any user, but with no retention window today either).
- [ ] Evaluate trimming stored scan inventories after classification — once an
  app in a session is classified, retaining its full record alongside the
  still-unclassified apps may not be necessary. Needs confirmation that the
  refresh flow and community-submission anti-abuse check (which validates
  against `raw_apps`) still work against a trimmed array.

---

Source: full findings in the 2026-07-13 Privacy & Data Governance Audit
(scanner, server, database schema, and third-party egress, verified against
the actual implementation).
