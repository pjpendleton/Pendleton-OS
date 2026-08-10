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

  it('exchanges the configured passcode without retaining it in the client', () => {
    const service = new DevicePairingService('a'.repeat(32), {
      now: () => 1_000,
      passcode: '2468',
    });
    const session = service.claimPasscode('2468', 'phone-1');

    expect(service.verifySession(session.cookieValue)).toBe(true);
    expect(() => service.claimPasscode('1111', 'phone-1')).toThrow('DEVICE_PIN_INVALID');
  });

  it('rate limits repeated invalid passcodes and permits recovery after the lockout', () => {
    let now = 1_000;
    const service = new DevicePairingService('a'.repeat(32), {
      now: () => now,
      passcode: '2468',
      pinAttemptWindowMs: 1_000,
      pinLockoutMs: 2_000,
      pinMaxAttempts: 3,
    });

    expect(() => service.claimPasscode('1111', 'phone-1')).toThrow('DEVICE_PIN_INVALID');
    expect(() => service.claimPasscode('2222', 'phone-1')).toThrow('DEVICE_PIN_INVALID');
    expect(() => service.claimPasscode('3333', 'phone-1')).toThrow('DEVICE_PIN_RATE_LIMITED');
    expect(() => service.claimPasscode('2468', 'phone-1')).toThrow('DEVICE_PIN_RATE_LIMITED');

    now = 3_001;
    expect(service.verifySession(service.claimPasscode('2468', 'phone-1').cookieValue)).toBe(true);
  });
});
