# Pendleton OS Voice Gateway v1

Version: 1.0.0  
Status: Implemented foundation

## Purpose

Voice is an interface over the Pendleton OS kernel. It does not contain business logic and cannot
invoke provider adapters directly. Every accepted voice action follows the canonical path:

`Voice -> Unified Command Gateway -> Context -> Intake -> Policy -> Workflow -> Verification -> Audit`

## v1 capability

The first supported action captures an internal artifact. The caller supplies a stable
idempotency key for the utterance, allowing retries without duplicating work. The request records
whether the user is driving so the Policy Matrix can apply driving-specific handling.

### Discover capabilities

`GET /v1/voice/capabilities`

### Capture an internal artifact

`POST /v1/voice/artifacts`

```json
{
  "idempotencyKey": "voice-session-1-utterance-1",
  "title": "Driving note",
  "text": "Follow up on the title report.",
  "drivingMode": true
}
```

Both endpoints require the existing Pendleton OS bearer credential. The browser or mobile client
must never receive the Google OAuth credential, database credential, or another provider secret.

## Safety boundaries

- The server controls the principal and project binding.
- Empty content and missing idempotency keys fail before kernel intake.
- The interface channel is always recorded as `voice`.
- Consequential actions are not part of this slice and remain confirmation-gated by policy.
- A provider response is not success; the workflow must complete independent verification and
  correlated audit recording.

## Next slice

Add short-lived realtime session issuance, authenticated conversation state, tool-result relay,
and a driving-safe spoken response formatter. This requires an OpenAI Platform API credential and
must not expose the long-lived key to the client.
