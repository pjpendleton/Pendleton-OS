# Voice Conversation Reliability v1

Status: Implemented; production deployment pending

Version: 1.1.0

Date: 2026-08-10

## Objective

Make Pendleton OS voice sessions durable, recoverable, project-aware, and safe enough for hands-free use without moving business authority into the phone client. This increment implements ADR-003, ADR-004, the Voice Operating Contract v1, and the Conversation Runtime v1.3 contract.

## Reliability guarantees

- Final user and assistant transcripts are normalized, retried, and appended with provider-derived idempotency keys.
- Duplicate Realtime events return the existing turn instead of creating duplicate memory.
- A session close writes a bounded recap; recent recaps return as context in later sessions for the same principal and project.
- Model tool calls cross one authenticated server broker with a fixed allowlist.
- Knowledge search always uses the durable session's active project.
- Artifact and follow-up creation always uses the Unified Command Gateway and its policy, verification, idempotency, and audit controls.
- Natural-language project selection resolves only an unambiguous active alias authorized to the Pendleton OS owner.
- Raw microphone audio and provider credentials are not persisted in the browser or conversation database.

## Server tool allowlist

1. `search_project_knowledge` — read-only governed retrieval.
2. `propose_artifact_create` — verified internal document proposal.
3. `capture_follow_up` — verified internal follow-up capture.
4. `list_projects` — bounded active-project discovery filtered by owner authorization.
5. `select_project` — governed session-scope change through project aliases.

Unknown tools, malformed arguments, cross-principal sessions, inactive projects, ambiguous aliases, and unconfigured services fail closed. Every completed or rejected allowed tool call is returned to the model and recorded as a durable tool result when the session remains writable.

## Operational boundary

OpenAI WebRTC continues to carry realtime audio and provider events. The phone transports normalized transcript and function-call envelopes to Pendleton OS; it does not choose project authority, invoke adapters directly, or decide whether a consequential action is permitted. Future provider-native sideband transport may remove the browser relay without changing this contract.
