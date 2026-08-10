import { describe, expect, it, vi } from 'vitest';
import { PostgresConversationRepository, type QueryResult } from '../src/index.js';

describe('PostgresConversationRepository', () => {
  it('casts reused close parameters so PostgreSQL assigns one consistent type', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          session_id: '00000000-0000-4000-8000-000000000001',
          contract_version: '1.0.0',
          principal_id: 'peter',
          project_id: 'pendleton-os',
          channel: 'voice',
          driving_mode: true,
          status: 'closed',
          started_at: new Date('2026-08-10T15:00:00.000Z'),
          last_activity_at: new Date('2026-08-10T15:01:00.000Z'),
          closed_at: new Date('2026-08-10T15:01:00.000Z'),
        },
      ],
    } satisfies QueryResult);
    const repository = new PostgresConversationRepository({ query });

    await repository.updateSessionStatus(
      '00000000-0000-4000-8000-000000000001',
      'closed',
      '2026-08-10T15:01:00.000Z',
    );

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('$2::text');
    expect(sql).toContain('$3::timestamptz');
  });
});
