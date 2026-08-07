import { describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeProvider } from '../src/index.js';

describe('OpenAIRealtimeProvider', () => {
  it('keeps the standard API key server-side and returns the SDP answer', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('answer-sdp', {
        status: 201,
        headers: { location: '/v1/realtime/calls/rtc_123' },
      }),
    );
    const provider = new OpenAIRealtimeProvider('sk-test-12345678901234567890', fetcher);
    const answer = await provider.createCall({
      sdp: 'offer-sdp',
      safetyIdentifier: 'hashed-user',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        instructions: 'Be helpful.',
        audio: { output: { voice: 'marin' } },
        tools: [],
        tool_choice: 'auto',
      },
    });
    expect(answer).toEqual({ sdp: 'answer-sdp', location: '/v1/realtime/calls/rtc_123' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/calls',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer sk-test-12345678901234567890',
          'OpenAI-Safety-Identifier': 'hashed-user',
        },
      }),
    );
  });
});
