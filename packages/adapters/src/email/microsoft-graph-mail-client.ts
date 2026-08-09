import type {
  EmailAddress,
  EmailConnectorStatus,
  EmailMessageSummary,
  ReadOnlyEmailClient,
} from '@pendleton-os/application';

interface MicrosoftTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
}

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
}

const address = (value: GraphAddress | undefined): EmailAddress | undefined => {
  const email = value?.emailAddress;
  if (!email?.address) return undefined;
  return { ...(email.name ? { name: email.name } : {}), address: email.address };
};

export class MicrosoftDelegatedTokenProvider {
  #tokens: MicrosoftTokenSet;

  constructor(
    private readonly clientId: string,
    tokens: MicrosoftTokenSet,
    private readonly tenant = 'common',
    private readonly now: () => number = () => Date.now(),
  ) {
    this.#tokens = { ...tokens };
  }

  async accessToken(): Promise<string> {
    const expiresAt = this.#tokens.expires_at ?? 0;
    if (this.#tokens.access_token && (expiresAt === 0 || expiresAt > this.now() + 60_000))
      return this.#tokens.access_token;
    if (!this.#tokens.refresh_token) throw new Error('MICROSOFT_AUTHORIZATION_REQUIRED');
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.#tokens.refresh_token,
      scope: 'openid profile offline_access User.Read Mail.Read',
    });
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    );
    if (!response.ok) throw new Error('MICROSOFT_TOKEN_REFRESH_FAILED');
    const refreshed = (await response.json()) as MicrosoftTokenSet;
    this.#tokens = {
      ...this.#tokens,
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? this.#tokens.refresh_token,
      expires_at: this.now() + (refreshed.expires_in ?? 3600) * 1000,
    };
    return this.#tokens.access_token;
  }
}

export class MicrosoftGraphMailClient implements ReadOnlyEmailClient {
  readonly provider = 'microsoft-graph' as const;
  #accountId: string | undefined;

  constructor(private readonly tokens: MicrosoftDelegatedTokenProvider) {}

  async #get(path: string): Promise<Response> {
    const token = await this.tokens.accessToken();
    return fetch(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async status(): Promise<EmailConnectorStatus> {
    try {
      const response = await this.#get('/me?$select=mail,userPrincipalName');
      if (response.status === 401 || response.status === 403)
        return {
          provider: this.provider,
          state: 'authorization_required',
          permissionMode: 'read-only',
          detail: 'MICROSOFT_MAIL_READ_SCOPE_REQUIRED',
        };
      if (!response.ok) throw new Error('MICROSOFT_PROFILE_FAILED');
      const profile = (await response.json()) as { mail?: string; userPrincipalName?: string };
      this.#accountId = profile.mail ?? profile.userPrincipalName;
      return {
        provider: this.provider,
        state: this.#accountId ? 'ready' : 'error',
        permissionMode: 'read-only',
        ...(this.#accountId
          ? { accountId: this.#accountId }
          : { detail: 'ACCOUNT_ID_UNAVAILABLE' }),
      };
    } catch (error) {
      const authorizationRequired =
        error instanceof Error && error.message.includes('AUTHORIZATION_REQUIRED');
      return {
        provider: this.provider,
        state: authorizationRequired ? 'authorization_required' : 'error',
        permissionMode: 'read-only',
        detail: authorizationRequired
          ? 'MICROSOFT_AUTHORIZATION_REQUIRED'
          : 'MICROSOFT_STATUS_FAILED',
      };
    }
  }

  async search(query: string, maxResults: number): Promise<readonly EmailMessageSummary[]> {
    const accountId = this.#accountId ?? (await this.status()).accountId;
    if (accountId === undefined) throw new Error('MICROSOFT_AUTHORIZATION_REQUIRED');
    const params = new URLSearchParams({
      $search: '"' + query.replaceAll('"', '\\"') + '"',
      $top: String(maxResults),
      $select:
        'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments',
    });
    const response = await this.#get(`/me/messages?${params.toString()}`);
    if (!response.ok) throw new Error(`MICROSOFT_MAIL_SEARCH_FAILED_${String(response.status)}`);
    const body = (await response.json()) as { value?: GraphMessage[] };
    return (body.value ?? []).flatMap((message) => {
      if (!message.id) return [];
      const sender = address(message.from);
      const recipients = [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]
        .map(address)
        .filter((item): item is EmailAddress => item !== undefined);
      return [
        {
          provider: this.provider,
          accountId,
          messageId: message.id,
          ...(message.conversationId ? { threadId: message.conversationId } : {}),
          subject: message.subject ?? '(no subject)',
          ...(sender ? { sender } : {}),
          recipients,
          ...(message.receivedDateTime ? { receivedAt: message.receivedDateTime } : {}),
          snippet: message.bodyPreview ?? '',
          ...(message.hasAttachments === undefined
            ? {}
            : { hasAttachments: message.hasAttachments }),
        },
      ];
    });
  }
}
