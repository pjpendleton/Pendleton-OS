# Pendleton OS Voice Gateway v1

Version: 1.1.0
Status: Production deployed

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

Both endpoints require an authenticated Pendleton OS principal. Administrative clients may use the
server bearer credential. Paired mobile devices use a signed, `HttpOnly`, `Secure`,
`SameSite=Strict` device-session cookie and never receive the permanent bearer credential. The
browser or mobile client must never receive the Google OAuth credential, database credential,
OpenAI API key, or another provider secret.

## Mobile device pairing

`GET /pair` serves the desktop authorization page. An administrator creates a five-minute,
single-use pairing link through `POST /v1/device-pairings`. The server stores only a hash of the
pending pairing secret. The QR code encodes the secret in the URL fragment, so it is not sent in
the initial HTTP request or included in ordinary access logs.

The iPhone claim page exchanges the secret through `POST /v1/device-pairings/claim`. A successful
claim consumes the secret and sets a signed 30-day device cookie. Pairing codes are deliberately
ephemeral and process-local; a deployment or restart safely invalidates any unclaimed code.
Changing `PENDLETON_API_TOKEN` invalidates all device sessions. `POST /v1/auth/logout` clears the
current device session.

## Safety boundaries

- The server controls the principal and project binding.
- Empty content and missing idempotency keys fail before kernel intake.
- The interface channel is always recorded as `voice`.
- Consequential actions are not part of this slice and remain confirmation-gated by policy.
- A provider response is not success; the workflow must complete independent verification and
  correlated audit recording.

## Next slice

Add named-device inventory and individual device revocation without changing the cookie or policy
boundary.
