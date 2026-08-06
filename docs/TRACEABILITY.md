# Specification traceability

| Repository capability             | Governing authority                                        | Backlog |
| --------------------------------- | ---------------------------------------------------------- | ------- |
| Workspace and delivery controls   | ADR-005; Technology Profile sections 3, 4, 15-20           | KRN-002 |
| Core contract schemas             | API Contract v1; Glossary v1; Technology Profile section 6 | KRN-003 |
| Strict TypeScript configuration   | Coding Standards v1; Technology Profile section 5          | KRN-002 |
| Container and PostgreSQL baseline | ADR-005; Technology Profile sections 3, 8, 17              | KRN-002 |
| Schema validation tests           | Coding Standards v1; Technology Profile sections 6 and 15  | KRN-003 |
| Command intake and idempotency    | API Contract v1; Technology Profile sections 6 and 9       | KRN-004 |
| Identity and project resolution   | Policy Matrix v1; System Design context boundary           | KRN-005 |
| Versioned policy evaluation       | Policy Matrix v1; Voice Operating Contract v1              | KRN-006 |
| Durable workflow orchestration    | System Design workflow boundary; API Contract v1           | KRN-007 |
| Scoped Google Drive adapter       | Policy Matrix Google Drive rules; adapter contract         | KRN-008 |
| Independent artifact verification | System Design verification boundary; API Contract v1       | KRN-009 |

Every future material behavior, schema, workflow, provider mutation, or public interface must
add or update its traceability entry in the same controlled change.
