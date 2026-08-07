import type {
  RealtimeCallAnswer,
  RealtimeCallRequest,
  RealtimeSessionProvider,
} from '@pendleton-os/application';

export class OpenAIRealtimeProvider implements RealtimeSessionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (apiKey.trim().length < 20) throw new Error('OPENAI_API_KEY_INVALID');
  }

  async createCall(request: RealtimeCallRequest): Promise<RealtimeCallAnswer> {
    const form = new FormData();
    form.set('sdp', request.sdp);
    form.set('session', JSON.stringify(request.session));
    const response = await this.fetcher('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Safety-Identifier': request.safetyIdentifier,
      },
      body: form,
    });
    const sdp = await response.text();
    if (!response.ok) throw new Error(`OPENAI_REALTIME_ERROR:${String(response.status)}`);
    const location = response.headers.get('location');
    return { sdp, ...(location === null ? {} : { location }) };
  }
}
