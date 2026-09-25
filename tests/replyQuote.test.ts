/**
 * Regression tests for WhatsApp-style reply quotes (lib/replyQuote.ts).
 *
 * Contract under test:
 * - the quote resolves ONLY from already-decrypted local messages (the caller
 *   passes the resolved target or null — this module never fetches/decrypts)
 * - text quotes show author + truncated content
 * - media/sticker/gif targets fall back to honest labels, never raw payloads
 * - a missing original (deleted/expired) yields an explicit unavailable quote
 * - `isContent` tells the renderer whether Coded-mode encoding applies
 */
import { describe, it, expect } from 'vitest';
import {
  describeReplyQuote,
  REPLY_QUOTE_MAX_LENGTH,
  REPLY_QUOTE_UNAVAILABLE,
} from '@/lib/replyQuote';

const PEER = 'Atharva';
const ME = 'uid-me';

describe('describeReplyQuote', () => {
  it('quotes peer text with the peer label', () => {
    expect(
      describeReplyQuote(
        { senderId: 'uid-peer', plaintext: 'hello there' },
        { myUid: ME, peerLabel: PEER }
      )
    ).toEqual({ author: PEER, text: 'hello there', available: true, isContent: true });
  });

  it('labels own messages as You', () => {
    const q = describeReplyQuote(
      { senderId: ME, plaintext: 'my own words' },
      { myUid: ME, peerLabel: PEER }
    );
    expect(q.author).toBe('You');
    expect(q.text).toBe('my own words');
    expect(q.available).toBe(true);
  });

  it('truncates long quotes instead of dumping full text', () => {
    const long = 'x'.repeat(REPLY_QUOTE_MAX_LENGTH + 40);
    const q = describeReplyQuote(
      { senderId: 'uid-peer', plaintext: long },
      { myUid: ME, peerLabel: PEER }
    );
    expect(q.text.length).toBeLessThanOrEqual(REPLY_QUOTE_MAX_LENGTH + 1);
    expect(q.text.endsWith('…')).toBe(true);
    expect(q.isContent).toBe(true);
  });

  it('uses media labels when a photo/video has no caption', () => {
    expect(
      describeReplyQuote(
        { senderId: 'uid-peer', plaintext: ' ', mediaType: 'image' },
        { myUid: ME, peerLabel: PEER }
      ).text
    ).toBe('Photo');
    expect(
      describeReplyQuote(
        { senderId: 'uid-peer', plaintext: ' ', mediaType: 'video' },
        { myUid: ME, peerLabel: PEER }
      ).text
    ).toBe('Video');
  });

  it('quotes a media caption when one exists', () => {
    const q = describeReplyQuote(
      { senderId: 'uid-peer', plaintext: 'look at this', mediaType: 'image' },
      { myUid: ME, peerLabel: PEER }
    );
    expect(q).toEqual({ author: PEER, text: 'look at this', available: true, isContent: true });
  });

  it('labels stickers and GIFs without exposing payloads', () => {
    expect(
      describeReplyQuote(
        { senderId: 'uid-peer', plaintext: ' ', msgType: 'sticker' },
        { myUid: ME, peerLabel: PEER }
      )
    ).toEqual({ author: PEER, text: 'Sticker', available: true, isContent: false });
    expect(
      describeReplyQuote(
        { senderId: 'uid-peer', plaintext: ' ', msgType: 'gif' },
        { myUid: ME, peerLabel: PEER }
      ).text
    ).toBe('GIF');
  });

  it('falls back honestly when the original is unavailable', () => {
    expect(
      describeReplyQuote(null, { myUid: ME, peerLabel: PEER })
    ).toEqual({
      author: 'Original message',
      text: REPLY_QUOTE_UNAVAILABLE,
      available: false,
      isContent: false,
    });
  });
});
