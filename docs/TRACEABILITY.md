# Specification traceability

| Repository capability             | Governing authority                                        | Backlog       |
| --------------------------------- | ---------------------------------------------------------- | ------------- |
| Workspace and delivery controls   | ADR-005; Technology Profile sections 3, 4, 15-20           | KRN-002       |
| Core contract schemas             | API Contract v1; Glossary v1; Technology Profile section 6 | KRN-003       |
| Strict TypeScript configuration   | Coding Standards v1; Technology Profile section 5          | KRN-002       |
| Container and PostgreSQL baseline | ADR-005; Technology Profile sections 3, 8, 17              | KRN-002       |
| Schema validation tests           | Coding Standards v1; Technology Profile sections 6 and 15  | KRN-003       |
| Command intake and idempotency    | API Contract v1; Technology Profile sections 6 and 9       | KRN-004       |
| Identity and project resolution   | Policy Matrix v1; System Design context boundary           | KRN-005       |
| Versioned policy evaluation       | Policy Matrix v1; Voice Operating Contract v1              | KRN-006       |
| Durable workflow orchestration    | System Design workflow boundary; API Contract v1           | KRN-007       |
| Scoped Google Drive adapter       | Policy Matrix Google Drive rules; adapter contract         | KRN-008       |
| Independent artifact verification | System Design verification boundary; API Contract v1       | KRN-009       |
| Immutable event and audit trail   | System Design Event Log; Technology Profile section 13     | KRN-010       |
| Unified command gateway           | ADR-004; API Contract v1; Technology Profile section 7     | KRN-011       |
| Verified Drive vertical slice     | System Design canonical kernel path; API Contract v1       | KRN-012       |
| Operational hardening             | Technology Profile sections 8, 13, 15, 17                  | KRN-013       |
| Durable project registry          | System Design project context; API Contract v1             | PROJECT-001   |
| Read-only email search            | System Design adapters; ADR-004; Policy Matrix v1          | EMAIL-001     |
| Project knowledge retrieval       | System Design context boundary; ADR-003; ADR-004           | KNOWLEDGE-001 |
| Durable conversation runtime      | ADR-003; ADR-004; Voice Operating Contract v1              | VOICE-001     |
| Voice conversation reliability    | ADR-003; ADR-004; Conversation Runtime v1.3                | VOICE-002     |

Every future material behavior, schema, workflow, provider mutation, or public interface must
add or update its traceability entry in the same controlled change.
