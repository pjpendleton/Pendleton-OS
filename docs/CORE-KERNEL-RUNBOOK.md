# Core Kernel Runbook

Version: 1.0.0  
Status: Accepted

## Health and readiness

- Liveness confirms that the API process can serve requests.
- Readiness requires the policy catalog, durable event store, workflow store, identity/project directories, and enabled provider adapters.
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

Run `pnpm check` and `pnpm build`; apply migrations transactionally; verify readiness; execute one authorized Google Drive create/readback smoke test; then enable production traffic.
