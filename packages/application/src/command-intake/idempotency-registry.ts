export interface ReservationRequest {
  readonly actorId: string;
  readonly projectId: string;
  readonly commandType: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly commandId: string;
  readonly createdAt: string;
}

export type ReservationResult =
  | { readonly disposition: 'reserved' }
  | { readonly disposition: 'duplicate'; readonly commandId: string }
  | { readonly disposition: 'conflict'; readonly commandId: string };

export interface IdempotencyRegistry {
  reserve(request: ReservationRequest): Promise<ReservationResult>;
}

interface StoredReservation {
  readonly requestFingerprint: string;
  readonly commandId: string;
}

export class InMemoryIdempotencyRegistry implements IdempotencyRegistry {
  readonly #records = new Map<string, StoredReservation>();

  reserve(request: ReservationRequest): Promise<ReservationResult> {
    const scopeKey = [
      request.actorId,
      request.projectId,
      request.commandType,
      request.idempotencyKey,
    ].join(':');
    const existing = this.#records.get(scopeKey);
    if (existing === undefined) {
      this.#records.set(scopeKey, {
        requestFingerprint: request.requestFingerprint,
        commandId: request.commandId,
      });
      return Promise.resolve({ disposition: 'reserved' });
    }

    if (existing.requestFingerprint === request.requestFingerprint) {
      return Promise.resolve({ disposition: 'duplicate', commandId: existing.commandId });
    }

    return Promise.resolve({ disposition: 'conflict', commandId: existing.commandId });
  }
}
