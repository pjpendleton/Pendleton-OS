# Pendleton Conversation Runtime v1

Status: Production deployed with realtime voice and secure mobile device pairing

Version: 1.1.1

Date: 2026-08-08

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
- `POST /v1/conversations/{sessionId}/close` closes the session while retaining its record.
- `POST /v1/conversations/{sessionId}/realtime` accepts an authenticated WebRTC SDP offer and returns the provider SDP answer.
- `GET /voice` serves the mobile WebRTC client used from iPhone Safari or an installed home-screen shortcut.

All routes require an authenticated Pendleton OS principal. Administrative callers may use the server bearer credential; paired mobile devices use a signed, secure, HTTP-only device cookie. Session ownership is verified on every read and write.

## Persistence and security

`conversation_sessions` stores session identity, project scope, channel, driving mode, lifecycle state, and activity timestamps. `conversation_turns` stores ordered turns and optional command/correlation identifiers. Foreign keys, check constraints, unique idempotency keys, and resume indexes enforce the durable contract.

The migrations explicitly revoke access from Supabase `anon` and `authenticated` roles. Pendleton OS accesses these internal tables only through the dedicated `pendleton_runtime` server-side PostgreSQL role. That role has only the table and sequence privileges required to read, create, and update conversation records, with matching row-level security policies. No browser or mobile client receives direct database credentials.

## Deliberate v1 boundary

The Realtime integration uses `gpt-realtime-2.1` with the `marin` voice by default. The standard OpenAI API key stays on the Pendleton OS server. The mobile client receives only the SDP answer needed to establish its WebRTC media connection. The model receives recent durable transcript context and may call `propose_artifact_create`; the tool is explicitly a proposal and cannot bypass Pendleton OS policy, confirmation, verification, or audit controls.

The mobile page starts and closes durable voice sessions, requests microphone access, plays realtime assistant audio, reports connection state, and provides a large explicit interruption control. The permanent access token is never entered or retained on the phone. A one-time desktop pairing ceremony grants a signed 30-day secure device cookie. When the model proposes an internal artifact, the client submits it through the existing authenticated voice gateway and returns the real policy/workflow result to the model before conversation continues.

This slice does not yet provide server-side sideband tool execution, automatic transcript event ingestion, long-session summarization, or project knowledge retrieval. Those capabilities attach to this runtime without changing its authority boundaries.
