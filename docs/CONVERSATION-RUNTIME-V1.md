# Pendleton Conversation Runtime v1

Status: Production deployed with realtime voice and secure mobile device pairing

Version: 1.4.0

Date: 2026-08-10

## Purpose

The Conversation Runtime makes voice, mobile, and web interactions durable conversations rather than isolated commands. It implements the session and transcript foundation required by ADR-003, Voice as a First-Class Interface, and ADR-004, Unified Command and Workflow Layer. Business actions proposed during a conversation must still pass through the unified command gateway, policy evaluation, confirmation, verification, and audit controls defined by the System Design and Voice Operating Contract v1.

## Runtime contract

A session binds one authenticated principal to one project, interface channel, and driving-mode setting. The server controls principal and project identity; clients cannot substitute either value. Each turn records a role, semantic kind, transcript text, idempotency key, optional command linkage, and durable ordering.

Driving mode changes presentation, not authority. A resumed driving session returns `responseStyle: brief`; it does not relax confirmation or policy requirements.

Raw audio is not retained in v1. Only text transcripts and explicit tool/action records are persisted.

## API

- `POST /v1/conversations` starts a session.
- `GET /v1/conversations/{sessionId}` resumes the session with up to 50 recent turns.
- `POST /v1/conversations/{sessionId}/turns` appends an idempotent transcript or action record.
- `POST /v1/conversations/{sessionId}/realtime-events` ingests a normalized final user or assistant transcript event.
- `POST /v1/conversations/{sessionId}/tools` brokers an allowlisted Realtime tool call on the server.
- `POST /v1/conversations/{sessionId}/close` closes the session while retaining its record.
- `POST /v1/conversations/{sessionId}/realtime` accepts an authenticated WebRTC SDP offer and returns the provider SDP answer.
- `GET /voice` serves the mobile WebRTC client used from iPhone Safari or an installed home-screen shortcut.

All routes require an authenticated Pendleton OS principal. Administrative callers may use the server bearer credential; paired mobile devices use a signed, secure, HTTP-only device cookie. Session ownership is verified on every read and write.

## Persistence and security

`conversation_sessions` stores session identity, project scope, channel, driving mode, lifecycle state, and activity timestamps. `conversation_turns` stores ordered turns and optional command/correlation identifiers. Foreign keys, check constraints, unique idempotency keys, and resume indexes enforce the durable contract.

The migrations explicitly revoke access from Supabase `anon` and `authenticated` roles. Pendleton OS accesses these internal tables only through the dedicated `pendleton_runtime` server-side PostgreSQL role. That role has only the table and sequence privileges required to read, create, and update conversation records, with matching row-level security policies. No browser or mobile client receives direct database credentials.

## Deliberate v1 boundary

The Realtime integration uses `gpt-realtime-2.1` with the `marin` voice by default. The standard OpenAI API key stays on the Pendleton OS server. The mobile client receives only the SDP answer needed to establish its WebRTC media connection. The model receives recent durable transcript context and prior project conversation recaps. It may call `propose_artifact_create`; the tool is explicitly a proposal and cannot bypass Pendleton OS policy, confirmation, verification, or audit controls.

The model may also call `search_project_knowledge`. That read-only tool searches the session's
server-bound active project across governed Google Drive, Gmail, and Outlook sources. The phone
receives only bounded result metadata and excerpts, while the aggregate query and successful
provider reads are recorded in the kernel audit trail without storing query text or source content.

The mobile page starts and closes durable voice sessions, requests microphone access, plays realtime assistant audio, reports connection state, and provides a large explicit interruption control. The permanent access token is never entered or retained on the phone. A server-validated, rate-limited device PIN grants a signed 30-day secure device cookie; the one-time desktop QR ceremony remains available as recovery. The PIN is held only in the production secret store and grants paired-device authority rather than administrator authority.

The browser forwards only normalized final transcript events and model function-call envelopes to the authenticated conversation API. Tool dispatch, active-project scope, policy evaluation, verification, and durable result recording occur on the server. Final user and assistant transcripts are retried and written idempotently. Closing a session produces a bounded durable recap, and subsequent sessions for the same principal and project receive recent recaps as project memory.

`list_projects` returns a bounded list of registered projects authorized to the owner, including lifecycle status, and identifies the current conversation project without exposing membership or resource internals. Candidate and archived projects are visible for review but remain unavailable for selection or commands. `select_project` resolves a natural project name through the governed alias registry and changes the session scope only for one unambiguous, active, authorized project. `capture_follow_up` converts an explicit request to remember or track an action into the same verified internal-artifact workflow used by other voice actions.

Provider-native sideband WebSocket control remains a future transport hardening option. The v1.3 authority boundary does not depend on browser-owned business logic: the browser transports the function-call envelope, while Pendleton OS alone validates and executes it.
