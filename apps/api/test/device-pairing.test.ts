import { describe, expect, it } from 'vitest';
import { DevicePairingService } from '../src/device-pairing.js';

describe('device pairing', () => {
  it('exchanges a single-use pairing token for a signed device session', () => {
    const service = new DevicePairingService('a'.repeat(32), { now: () => 1_000 });
    const pairing = service.createPairing();
    const session = service.claimPairing(pairing.token);

    expect(service.verifySession(session.cookieValue)).toBe(true);
    expect(() => service.claimPairing(pairing.token)).toThrow('DEVICE_PAIRING_INVALID');
    expect(service.sessionCookie(session.cookieValue)).toContain(
      'HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('rejects expired pairing tokens and tampered device sessions', () => {
    let now = 1_000;
    const service = new DevicePairingService('a'.repeat(32), {
      now: () => now,
      pairingTtlMs: 500,
    });
    const pairing = service.createPairing();
    now = 1_501;

    expect(() => service.claimPairing(pairing.token)).toThrow('DEVICE_PAIRING_EXPIRED');

    now = 2_000;
    const session = service.claimPairing(service.createPairing().token);
    expect(service.verifySession(`${session.cookieValue}x`)).toBe(false);
  });
});
