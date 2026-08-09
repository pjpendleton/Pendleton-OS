import type {
  EmailAddress,
  EmailConnectorStatus,
  EmailMessageSummary,
  ReadOnlyEmailClient,
} from '@pendleton-os/application';
import { google, type Auth, type gmail_v1 } from 'googleapis';

const splitAddresses = (value: string | undefined): readonly EmailAddress[] => {
  if (value === undefined) return [];
  return value.split(',').flatMap((entry) => {
    const trimmed = entry.trim();
    const match = /^(?:"?([^"<]+?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed);
    if (match !== null)
      return [{ ...(match[1]?.trim() ? { name: match[1].trim() } : {}), address: match[2] ?? '' }];
    return trimmed.includes('@') ? [{ address: trimmed }] : [];
  });
};

const header = (message: gmail_v1.Schema$Message, name: string): string | undefined =>
  message.payload?.headers?.find((item) => item.name?.toLowerCase() === name)?.value ?? undefined;

export class GoogleApisGmailClient implements ReadOnlyEmailClient {
  readonly provider = 'gmail' as const;
  readonly #gmail;
  #accountId: string | undefined;

  constructor(auth: Auth.OAuth2Client) {
    this.#gmail = google.gmail({ version: 'v1', auth });
  }

  async status(): Promise<EmailConnectorStatus> {
    try {
      const response = await this.#gmail.users.getProfile({ userId: 'me' });
      this.#accountId = response.data.emailAddress ?? undefined;
      return {
        provider: this.provider,
        state: this.#accountId === undefined ? 'error' : 'ready',
        permissionMode: 'read-only',
        ...(this.#accountId === undefined
          ? { detail: 'ACCOUNT_ID_UNAVAILABLE' }
          : { accountId: this.#accountId }),
      };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : 0;
      return {
        provider: this.provider,
        state: code === 401 || code === 403 ? 'authorization_required' : 'error',
        permissionMode: 'read-only',
        detail:
          code === 401 || code === 403 ? 'GMAIL_READONLY_SCOPE_REQUIRED' : 'GMAIL_STATUS_FAILED',
      };
    }
  }

  async search(query: string, maxResults: number): Promise<readonly EmailMessageSummary[]> {
    const accountId = this.#accountId ?? (await this.status()).accountId;
    if (accountId === undefined) throw new Error('GMAIL_AUTHORIZATION_REQUIRED');
    const listed = await this.#gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
      includeSpamTrash: false,
    });
    const messages = await Promise.all(
      (listed.data.messages ?? []).map(async ({ id }): Promise<EmailMessageSummary | undefined> => {
        if (!id) return undefined;
        const response = await this.#gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Date', 'Subject'],
        });
        const message = response.data;
        const receivedAt = message.internalDate
          ? new Date(Number(message.internalDate)).toISOString()
          : undefined;
        return {
          provider: this.provider,
          accountId,
          messageId: id,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          subject: header(message, 'subject') ?? '(no subject)',
          ...(splitAddresses(header(message, 'from'))[0]
            ? { sender: splitAddresses(header(message, 'from'))[0] }
            : {}),
          recipients: [
            ...splitAddresses(header(message, 'to')),
            ...splitAddresses(header(message, 'cc')),
          ],
          ...(receivedAt === undefined ? {} : { receivedAt }),
          snippet: message.snippet ?? '',
        } satisfies EmailMessageSummary;
      }),
    );
    return messages.filter((message): message is EmailMessageSummary => message !== undefined);
  }
}
