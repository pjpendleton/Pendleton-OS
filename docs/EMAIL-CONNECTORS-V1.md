# Pendleton OS Read-Only Email Connectors v1

Status: Implemented; account authorization pending

Version: 1.0.0

Date: 2026-08-08

## Purpose

Email is an external source of project evidence, commitments, decisions, risks, and action items. This service lets Pendleton OS locate relevant Gmail and Outlook messages without granting mailbox mutation authority or copying entire mailboxes into the platform.

This design implements the Book Charter's executive-assistance objective through the boundaries defined by System Design, ADR-003, ADR-004, the Policy Matrix, and API Contract v1. Voice, web, and mobile clients use the same authenticated application service; no interface calls Gmail or Microsoft Graph directly.

## Version 1 boundary

Version 1 is read-only and search-on-demand:

- Gmail permission: `gmail.readonly`.
- Microsoft Graph delegated permission: `Mail.Read`.
- Results contain message identifiers, subject, sender, recipients, received time, provider preview/snippet, conversation identifier, and attachment presence when available.
- Searches return at most 25 results.
- Full message bodies, attachment downloads, background mailbox synchronization, sending, replying, forwarding, moving, categorizing, archiving, and deletion are excluded.

Any mailbox mutation requires a separately accepted policy decision, a consequential-action confirmation design, verification, and an updated API contract.

## Authorization and credential handling

OAuth client configuration and delegated tokens remain server-side secrets. They are never committed, returned by an API, logged, embedded in the voice page, or persisted in an event payload. Google authorization preserves the existing Drive grant while adding Gmail read-only access. Microsoft authorization uses authorization-code flow with PKCE and requests offline access for a personal or organizational Microsoft account.

The runtime reports each connector as `ready`, `authorization_required`, `unconfigured`, or `error`. Account identifiers may be returned only to an authenticated administrator or paired device.

## Project and audit controls

`POST /v1/email/search` requires an authenticated administrator or paired device, a supported provider, an active project, and an actor authorized for that project. Candidate or archived projects cannot be used as an email-search context.

Every successful search appends `email.search.completed` to the kernel event store. The event records provider, account, project, actor, read-only mode, result count, and a SHA-256 query hash. It does not record the query text, subjects, senders, snippets, bodies, access tokens, or refresh tokens.

## API

- `GET /v1/email/connectors` returns safe connector state and permission mode.
- `POST /v1/email/search` performs a bounded, read-only search for one active project.

Example request:

```json
{
  "projectId": "pendleton-os",
  "provider": "gmail",
  "query": "from:example.com newer_than:90d",
  "maxResults": 10
}
```

## Activation sequence

1. Enable the Gmail API in the existing Google Cloud project.
2. Reauthorize the existing Google OAuth client for Drive plus Gmail read-only access.
3. replace the production Google token secret and verify connector state.
4. Register a Microsoft public-client application with a localhost redirect URI.
5. Authorize `User.Read` and `Mail.Read`, store the delegated token as a production secret, and verify connector state.
6. Run bounded searches against an active project and verify corresponding audit events.

No email connector is considered live until its production status is `ready` and a search/audit readback succeeds.
