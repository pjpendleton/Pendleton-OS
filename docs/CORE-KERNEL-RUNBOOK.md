# Core Kernel Runbook

Version: 1.2.0
Status: Accepted

## Health and readiness

- Liveness confirms that the API process can serve requests.
- Readiness requires the policy catalog, durable event store, workflow store, identity/project directories, and enabled provider adapters.
- Production readiness also requires an active `pendleton-os` registry record and a registered Google Drive `project-root` resource.
- Email is an optional readiness dependency until explicitly enabled. An enabled connector must report `ready`; `authorization_required` or `error` removes email capability without taking command, project, or voice services offline.
- Remove an instance from traffic whenever a required readiness dependency fails.

## Failure handling

1. Locate the correlation ID in the structured event log.
2. Reconstruct the command, policy decision, workflow steps, provider evidence, and verification result.
3. Do not retry a mutation outside the command gateway. Resubmit with the original idempotency key.
4. A verification mismatch is fail-closed; quarantine the workflow and compare provider evidence with intended state.
5. For an unavailable provider, retain the pending workflow and retry with bounded exponential backoff.

## Recovery

- Restore PostgreSQL to a new instance, run migrations in order, and reconcile the event sequence before enabling writes.
- Rebuild materialized workflow state from the append-only event stream where necessary.
- Rotate compromised credentials in the secret manager, revoke the old credential, restart affected instances, and verify that event payloads contain no secret values.

## Deployment gate

Run `npm run build` and `npm run check`; apply migrations transactionally; verify registry security advisors and readiness; execute one authorized Google Drive create/readback smoke test; then enable production traffic.

When email is enabled, also verify `GET /v1/email/connectors`, execute one bounded search against an active project, and confirm an `email.search.completed` event whose payload contains no query text or message content.
