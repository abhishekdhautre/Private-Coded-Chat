import { describe, expect, it } from 'vitest';
import { isDuplicateDelivery } from '@/lib/messageDedupe';

describe('isDuplicateDelivery (UI-layer idempotency, messageId-keyed)', () => {
  const row = { ciphertext: 'ct1', mediaData: 'media1' };

  it('skips a redelivery of an already-successfully-decrypted, unchanged row', () => {
    expect(
      isDuplicateDelivery({
        cached: { ciphertext: 'ct1', mediaData: 'media1' },
        decryptedSuccessfully: true,
        row,
      })
    ).toBe(true);
  });

  it('does not skip when there is no cached entry (new message)', () => {
    expect(
      isDuplicateDelivery({ cached: null, decryptedSuccessfully: false, row })
    ).toBe(false);
    expect(
      isDuplicateDelivery({ cached: undefined, decryptedSuccessfully: true, row })
    ).toBe(false);
  });

  it('does not skip when the previous decrypt failed (stays retryable)', () => {
    expect(
      isDuplicateDelivery({
        cached: { ciphertext: 'ct1', mediaData: 'media1' },
        decryptedSuccessfully: false,
        row,
      })
    ).toBe(false);
  });

  it('does not skip when ciphertext changed (edited message must re-decrypt)', () => {
    expect(
      isDuplicateDelivery({
        cached: { ciphertext: 'ct1', mediaData: 'media1' },
        decryptedSuccessfully: true,
        row: { ciphertext: 'ct2', mediaData: 'media1' },
      })
    ).toBe(false);
  });

  it('does not skip when media bytes changed', () => {
    expect(
      isDuplicateDelivery({
        cached: { ciphertext: 'ct1', mediaData: 'media1' },
        decryptedSuccessfully: true,
        row: { ciphertext: 'ct1', mediaData: 'media2' },
      })
    ).toBe(false);
  });

  it('treats absent media symmetrically (both undefined)', () => {
    expect(
      isDuplicateDelivery({
        cached: { ciphertext: 'ct1' },
        decryptedSuccessfully: true,
        row: { ciphertext: 'ct1' },
      })
    ).toBe(true);
  });

  it('does not skip when media appeared where there was none', () => {
    expect(
      isDuplicateDelivery({
        cached: { ciphertext: 'ct1' },
        decryptedSuccessfully: true,
        row: { ciphertext: 'ct1', mediaData: 'media1' },
      })
    ).toBe(false);
  });
});
