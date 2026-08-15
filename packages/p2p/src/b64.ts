/**
 * Internal base64 codec (RFC 4648, standard alphabet, with padding).
 *
 * This package runs without DOM or Node globals, so neither `btoa`/`atob` nor
 * `Buffer` exists — chunk payloads on the file channel are framed with this
 * pure-JS lookup-table implementation instead.
 */

/** Standard base64 alphabet, index = 6-bit value. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup: char code → 6-bit value, -1 for non-alphabet bytes. */
const DECODE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Padding character. */
const PAD = 61; // '='.charCodeAt(0)

/** Encode bytes as standard base64 (RFC 4648, with padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += i + 1 < bytes.length ? ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : '=';
    out += i + 2 < bytes.length ? ALPHABET.charAt(b2 & 0x3f) : '=';
  }
  return out;
}

/** Decode standard base64; throws Error('invalid base64') on malformed input. */
export function base64ToBytes(b64: string): Uint8Array {
  if (b64.length % 4 !== 0) throw new Error('invalid base64');
  let padding = 0;
  if (b64.length > 0 && b64.charCodeAt(b64.length - 1) === PAD) padding += 1;
  if (b64.length > 1 && b64.charCodeAt(b64.length - 2) === PAD) padding += 1;
  const out = new Uint8Array((b64.length / 4) * 3 - padding);
  let outIndex = 0;
  for (let i = 0; i < b64.length; i += 4) {
    // Padding is only legal as the final one or two characters.
    const lastGroup = i + 4 === b64.length;
    const c0 = b64.charCodeAt(i);
    const c1 = b64.charCodeAt(i + 1);
    const c2 = b64.charCodeAt(i + 2);
    const c3 = b64.charCodeAt(i + 3);
    const v0 = c0 < 128 ? (DECODE[c0] as number) : -1;
    const v1 = c1 < 128 ? (DECODE[c1] as number) : -1;
    const v2 = c2 === PAD && lastGroup ? 0 : c2 < 128 ? (DECODE[c2] as number) : -1;
    const v3 = c3 === PAD && lastGroup ? 0 : c3 < 128 ? (DECODE[c3] as number) : -1;
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) throw new Error('invalid base64');
    if (c2 === PAD && c3 !== PAD) throw new Error('invalid base64');
    if (outIndex < out.length) {
      out[outIndex] = (v0 << 2) | (v1 >> 4);
      outIndex += 1;
    }
    if (outIndex < out.length) {
      out[outIndex] = ((v1 & 0x0f) << 4) | (v2 >> 2);
      outIndex += 1;
    }
    if (outIndex < out.length) {
      out[outIndex] = ((v2 & 0x03) << 6) | v3;
      outIndex += 1;
    }
  }
  return out;
}
