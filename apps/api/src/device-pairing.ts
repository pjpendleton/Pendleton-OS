import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const DEVICE_SESSION_COOKIE = '__Host-pendleton_device';

interface PairingRecord {
  readonly secretHash: Buffer;
  readonly expiresAt: number;
}

interface FailedPinAttempts {
  readonly count: number;
  readonly windowStartedAt: number;
  readonly lockedUntil?: number;
}

interface DeviceSessionPayload {
  readonly v: 1;
  readonly aud: 'pendleton-device';
  readonly deviceId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface DevicePairing {
  readonly pairingId: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface ClaimedDeviceSession {
  readonly cookieValue: string;
  readonly expiresAt: string;
}

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();

const constantTimeEqual = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

export class DevicePairingService {
  readonly #signingSecret: string;
  readonly #pinHash: Buffer | undefined;
  readonly #now: () => number;
  readonly #pairingTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #pinAttemptWindowMs: number;
  readonly #pinLockoutMs: number;
  readonly #pinMaxAttempts: number;
  readonly #pairings = new Map<string, PairingRecord>();
  readonly #failedPinAttempts = new Map<string, FailedPinAttempts>();

  constructor(
    signingSecret: string,
    options: {
      now?: () => number;
      pairingTtlMs?: number;
      sessionTtlMs?: number;
      passcode?: string;
      pinAttemptWindowMs?: number;
      pinLockoutMs?: number;
      pinMaxAttempts?: number;
    } = {},
  ) {
    if (signingSecret.length < 32) throw new Error('DEVICE_SIGNING_SECRET_REQUIRED');
    if (options.passcode !== undefined && !/^\d{4,12}$/.test(options.passcode)) {
      throw new Error('DEVICE_PIN_INVALID_CONFIGURATION');
    }
    this.#signingSecret = signingSecret;
    this.#pinHash = options.passcode === undefined ? undefined : this.#hashPin(options.passcode);
    this.#now = options.now ?? Date.now;
    this.#pairingTtlMs = options.pairingTtlMs ?? 5 * 60 * 1_000;
    this.#sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1_000;
    this.#pinAttemptWindowMs = options.pinAttemptWindowMs ?? 15 * 60 * 1_000;
    this.#pinLockoutMs = options.pinLockoutMs ?? 15 * 60 * 1_000;
    this.#pinMaxAttempts = options.pinMaxAttempts ?? 5;
  }

  createPairing(): DevicePairing {
    this.#removeExpiredPairings();
    const pairingId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.#pairingTtlMs;
    this.#pairings.set(pairingId, { secretHash: hash(secret), expiresAt });
    return {
      pairingId,
      token: `${pairingId}.${secret}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  claimPairing(token: string): ClaimedDeviceSession {
    const separator = token.indexOf('.');
    if (separator < 1) throw new Error('DEVICE_PAIRING_INVALID');
    const pairingId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const pairing = this.#pairings.get(pairingId);
    if (pairing === undefined) throw new Error('DEVICE_PAIRING_INVALID');

    this.#pairings.delete(pairingId);
    if (pairing.expiresAt <= this.#now()) throw new Error('DEVICE_PAIRING_EXPIRED');
    if (!constantTimeEqual(pairing.secretHash, hash(secret))) {
      throw new Error('DEVICE_PAIRING_INVALID');
    }

    return this.#createSession();
  }

  claimPasscode(passcode: string, clientKey: string): ClaimedDeviceSession {
    if (this.#pinHash === undefined) throw new Error('DEVICE_PIN_NOT_CONFIGURED');
    this.#removeExpiredPinAttempts();
    const now = this.#now();
    const previous = this.#failedPinAttempts.get(clientKey);
    if (previous?.lockedUntil !== undefined && previous.lockedUntil > now) {
      throw new Error('DEVICE_PIN_RATE_LIMITED');
    }
    if (!constantTimeEqual(this.#pinHash, this.#hashPin(passcode))) {
      const withinWindow =
        previous !== undefined && now - previous.windowStartedAt < this.#pinAttemptWindowMs;
      const count = (withinWindow ? previous.count : 0) + 1;
      const windowStartedAt = withinWindow ? previous.windowStartedAt : now;
      this.#failedPinAttempts.set(clientKey, {
        count,
        windowStartedAt,
        ...(count >= this.#pinMaxAttempts ? { lockedUntil: now + this.#pinLockoutMs } : {}),
      });
      throw new Error(
        count >= this.#pinMaxAttempts ? 'DEVICE_PIN_RATE_LIMITED' : 'DEVICE_PIN_INVALID',
      );
    }
    this.#failedPinAttempts.delete(clientKey);
    return this.#createSession();
  }

  #createSession(): ClaimedDeviceSession {
    const issuedAt = this.#now();
    const expiresAt = issuedAt + this.#sessionTtlMs;
    const payload: DeviceSessionPayload = {
      v: 1,
      aud: 'pendleton-device',
      deviceId: randomUUID(),
      issuedAt,
      expiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return {
      cookieValue: `${encoded}.${this.#sign(encoded)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  verifySession(cookieValue: string | undefined): boolean {
    if (cookieValue === undefined) return false;
    const separator = cookieValue.lastIndexOf('.');
    if (separator < 1) return false;
    const encoded = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    if (!constantTimeEqual(Buffer.from(signature), Buffer.from(this.#sign(encoded)))) return false;

    try {
      const payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as Partial<DeviceSessionPayload>;
      return (
        payload.v === 1 &&
        payload.aud === 'pendleton-device' &&
        typeof payload.deviceId === 'string' &&
        typeof payload.issuedAt === 'number' &&
        typeof payload.expiresAt === 'number' &&
        payload.issuedAt <= this.#now() &&
        payload.expiresAt > this.#now()
      );
    } catch {
      return false;
    }
  }

  sessionCookie(value: string): string {
    const maxAge = Math.floor(this.#sessionTtlMs / 1_000);
    return `${DEVICE_SESSION_COOKIE}=${value}; Max-Age=${String(maxAge)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  }

  clearSessionCookie(): string {
    return `${DEVICE_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
  }

  cookieFromHeader(cookieHeader: string | undefined): string | undefined {
    if (cookieHeader === undefined) return undefined;
    for (const part of cookieHeader.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === DEVICE_SESSION_COOKIE) return value.join('=');
    }
    return undefined;
  }

  #sign(encodedPayload: string): string {
    return createHmac('sha256', this.#signingSecret).update(encodedPayload).digest('base64url');
  }

  #hashPin(passcode: string): Buffer {
    return createHmac('sha256', this.#signingSecret)
      .update(`pendleton-device-pin:${passcode}`)
      .digest();
  }

  #removeExpiredPairings(): void {
    const now = this.#now();
    for (const [pairingId, pairing] of this.#pairings) {
      if (pairing.expiresAt <= now) this.#pairings.delete(pairingId);
    }
  }

  #removeExpiredPinAttempts(): void {
    const now = this.#now();
    for (const [clientKey, attempts] of this.#failedPinAttempts) {
      const lockExpired = attempts.lockedUntil === undefined || attempts.lockedUntil <= now;
      const windowExpired = now - attempts.windowStartedAt >= this.#pinAttemptWindowMs;
      if (lockExpired && windowExpired) this.#failedPinAttempts.delete(clientKey);
    }
  }
}
