/**
 * Regression tests for mobile V3/V1 encrypted-media delivery.
 *
 * Exact production failure reproduced here:
 *
 *   iPhone picks an HEIC photo (File.type = "image/heic") -> composer preview
 *   renders (it uses the original File, so the original type) -> Send encrypts
 *   the bytes and writes them -> the RECEIVER rebuilds a Blob with a HARDCODED
 *   guess "image/jpeg" -> WebKit is handed a blob: resource declaring JPEG
 *   while the bytes are HEIC -> the <img> fails to decode -> the media message
 *   renders as nothing, i.e. "does not appear". Desktop worked because
 *   desktop-picked files really are image/jpeg, which matched the guess.
 *
 * These tests lock down:
 *   1. the real MIME type survives the store/reconstruct round trip,
 *   2. legacy rows written before `mediaMime` existed still resolve correctly,
 *   3. a media payload that never produced an object URL is NOT treated as
 *      permanently processed (so it stays retryable instead of being silently
 *      skipped as a duplicate forever),
 *   4. the Firebase message rule neither requires nor bans `mediaMime`,
 *   5. replay protection / dedupe semantics stay messageId-keyed.
 */

import { describe, expect, it } from 'vitest';
import {
  isMediaReady,
  mediaBlobMime,
  outgoingMediaMime,
} from '@/lib/mediaMime';
import { isDuplicateDelivery } from '@/lib/messageDedupe';
import { encryptBytes, decryptBytes } from '@/lib/crypto';
import rulesJson from '../firebase.rules.json';

type RulesTree = {
  rules: {
    rooms: {
      $roomId: {
        messages: {
          $messageId: { '.validate': string };
        };
      };
    };
  };
};
const messageValidate = (rulesJson as RulesTree).rules.rooms.$roomId.messages.$messageId['.validate'];

describe('media MIME fidelity (mobile V3 media delivery)', () => {
  it('round-trips an iPhone HEIC photo instead of relabelling it image/jpeg', () => {
    const stored = outgoingMediaMime('image/heic', 'image');
    expect(stored).toBe('image/heic');

    const rebuilt = mediaBlobMime({ mediaType: 'image', mediaMime: stored });
    expect(rebuilt).toBe('image/heic');
    // The exact old behaviour we are fixing:
    expect(rebuilt).not.toBe('image/jpeg');
  });

  it('preserves every realistic picker MIME type', () => {
    const cases: Array<[string, 'image' | 'video', string]> = [
      ['image/heic', 'image', 'image/heic'],
      ['image/heif', 'image', 'image/heif'],
      ['image/png', 'image', 'image/png'],
      ['image/jpeg', 'image', 'image/jpeg'],
      ['image/webp', 'image', 'image/webp'],
      ['image/gif', 'image', 'image/gif'],
      ['video/quicktime', 'video', 'video/quicktime'],
      ['video/mp4', 'video', 'video/mp4'],
      ['video/x-m4v', 'video', 'video/x-m4v'],
    ];
    for (const [fileType, mediaType, expected] of cases) {
      const stored = outgoingMediaMime(fileType, mediaType);
      expect(stored).toBe(expected);
      expect(mediaBlobMime({ mediaType, mediaMime: stored })).toBe(expected);
    }
  });

  it('falls back to the legacy guess when the picker reports no usable type', () => {
    expect(outgoingMediaMime('', 'image')).toBe('image/jpeg');
    expect(outgoingMediaMime(null, 'image')).toBe('image/jpeg');
    expect(outgoingMediaMime(undefined, 'video')).toBe('video/mp4');
    expect(outgoingMediaMime('application/octet-stream', 'video')).toBe('video/mp4');
  });

  it('keeps the legacy guess for rows stored before mediaMime existed', () => {
    expect(mediaBlobMime({ mediaType: 'image' })).toBe('image/jpeg');
    expect(mediaBlobMime({ mediaType: 'video' })).toBe('video/mp4');
    expect(mediaBlobMime({ mediaType: 'image', mediaMime: null })).toBe('image/jpeg');
    expect(mediaBlobMime({ mediaType: 'video', mediaMime: '' })).toBe('video/mp4');
  });

  it('rejects a stored MIME whose kind contradicts mediaType', () => {
    expect(mediaBlobMime({ mediaType: 'image', mediaMime: 'video/mp4' })).toBe('image/jpeg');
    expect(mediaBlobMime({ mediaType: 'video', mediaMime: 'image/heic' })).toBe('video/mp4');
    expect(mediaBlobMime({ mediaType: 'image', mediaMime: 'text/html' })).toBe('image/jpeg');
  });

  it('decrypts the payload and rebuilds a Blob with the phone-real MIME type', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const heicBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);

    const { data, iv } = await encryptBytes(heicBytes, key);
    const row = {
      mediaType: 'image',
      mediaMime: outgoingMediaMime('image/heic', 'image'),
      mediaData: data,
      mediaIv: iv,
    };

    const plain = await decryptBytes(row.mediaData, row.mediaIv, key);
    expect(Array.from(plain)).toEqual(Array.from(heicBytes));

    const buf = plain.buffer.slice(
      plain.byteOffset,
      plain.byteOffset + plain.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([buf], { type: mediaBlobMime(row) });
    // Before the fix this was always "image/jpeg" regardless of the real bytes.
    expect(blob.type).toBe('image/heic');
    expect(blob.size).toBe(heicBytes.byteLength);
  });
});

describe('failed media stays retryable (never permanently "processed")', () => {
  // Mirrors a cached decrypted message that still has its encrypted media
  // payload but never managed to produce a usable object URL.
  const cachedWithoutBlob = {
    ciphertext: 'ct1',
    mediaData: 'media1',
    mediaIv: 'iv1',
    mediaType: 'image',
    mediaBlobUrl: null as string | null,
  };
  const cachedWithBlob = { ...cachedWithoutBlob, mediaBlobUrl: 'blob:abc' };
  const deliveredRow = {
    ciphertext: 'ct1',
    mediaData: 'media1',
    mediaIv: 'iv1',
    mediaType: 'image',
  };
  const changedCipher = { ...deliveredRow, ciphertext: 'ct2' };
  const changedMedia = { ...deliveredRow, mediaData: 'media2' };
  const resequenced = { ...deliveredRow, sequenceNumber: 999 };

  it('isMediaReady gates on the object URL only when a media payload exists', () => {
    expect(isMediaReady(cachedWithoutBlob, null)).toBe(false);
    expect(isMediaReady(cachedWithoutBlob, '')).toBe(false);
    expect(isMediaReady(cachedWithBlob, 'blob:abc')).toBe(true);
    // Text-only rows are never gated.
    expect(isMediaReady({ mediaType: null }, null)).toBe(true);
    expect(isMediaReady(undefined, undefined)).toBe(true);
  });

  it('does not let the UI dedupe swallow a row whose media never rendered', () => {
    const processedIdsHas = true;
    // Exactly how the chat page computes the flag now:
    const decryptedSuccessfully =
      processedIdsHas && isMediaReady(cachedWithoutBlob, cachedWithoutBlob.mediaBlobUrl);
    expect(decryptedSuccessfully).toBe(false);

    // Therefore the duplicate-delivery guard must NOT skip it -> it is retried.
    expect(
      isDuplicateDelivery({ cached: cachedWithoutBlob, decryptedSuccessfully, row: deliveredRow })
    ).toBe(false);
  });

  it('still skips a row that both decrypted and produced its media URL', () => {
    const decryptedSuccessfully = isMediaReady(cachedWithBlob, cachedWithBlob.mediaBlobUrl);
    expect(decryptedSuccessfully).toBe(true);
    expect(
      isDuplicateDelivery({ cached: cachedWithBlob, decryptedSuccessfully, row: deliveredRow })
    ).toBe(true);
  });

  it('still re-decrypts when the ciphertext or media payload changed', () => {
    expect(
      isDuplicateDelivery({ cached: cachedWithBlob, decryptedSuccessfully: true, row: changedCipher })
    ).toBe(false);
    expect(
      isDuplicateDelivery({ cached: cachedWithBlob, decryptedSuccessfully: true, row: changedMedia })
    ).toBe(false);
  });

  it('never keys suppression off sequenceNumber — messageId/fingerprint only', () => {
    expect(
      isDuplicateDelivery({ cached: cachedWithBlob, decryptedSuccessfully: true, row: resequenced })
    ).toBe(true);
  });
});

describe('firebase rules accept the added mediaMime field', () => {
  it('neither requires nor bans mediaMime on a message', () => {
    // Firebase only enforces what the expression mentions, so a field absent
    // from .validate is unconstrained and additive writes stay legal.
    expect(messageValidate).not.toContain('mediaMime');
  });

  it('still bans secrets and still allows the V3 + media shape', () => {
    for (const banned of [
      'plaintext',
      'content',
      'rawKey',
      'chainKey',
      'messageKey',
      'roomMasterKey',
      'privateKey',
    ]) {
      expect(messageValidate).toContain(`hasChild('${banned}')`);
    }
    for (const required of [
      'messageId',
      'roomId',
      'epoch',
      'senderUid',
      'senderDeviceId',
      'ciphertext',
      'iv',
      'timestamp',
      'signature',
    ]) {
      expect(messageValidate).toContain(`'${required}'`);
    }
    // mediaType stays an enum, mediaData/mediaIv stay paired.
    expect(messageValidate).toContain(`newData.child('mediaType').val() == 'image'`);
    expect(messageValidate).toContain(`newData.child('mediaType').val() == 'video'`);
    expect(messageValidate).toContain(`!newData.hasChild('mediaData') == !newData.hasChild('mediaIv')`);
  });
});
