/**
 * UUIDv7 + 8-char entry id helpers.
 *
 * Coding-agent uses node's `crypto.randomUUID()` for short ids and the `uuid`
 * package's `v7()` for session ids. In the browser we have `randomUUID()`
 * (v4 only) and no built-in v7, so we inline the generator. Small enough that
 * a dep isn't worth it.
 */

/**
 * Monotonic counter that advances the UUIDv7 clock 1 ms forward when two
 * generations land in the same wall-clock millisecond. Keeps ids time-ordered
 * within a tight loop without adding runtime dependencies.
 */
let lastTimestampMs = 0;

/**
 * Generate a UUIDv7 string.
 *
 * Layout: 48-bit big-endian timestamp (unix ms) · 4-bit version (7) ·
 * 12-bit random · 2-bit variant (10) · 62-bit random. Lexicographic sort on
 * the string form orders by creation time (first-8-hex = most-significant
 * timestamp bytes), which is what we exploit in `listSessions`.
 */
export function generateSessionId(): string {
  let now = Date.now();
  if (now <= lastTimestampMs) {
    now = lastTimestampMs + 1;
  }
  lastTimestampMs = now;

  const rand = crypto.getRandomValues(new Uint8Array(10));
  const buf = new Uint8Array(16);

  // 48-bit timestamp in big-endian.
  buf[0] = (now / 2 ** 40) & 0xff;
  buf[1] = (now / 2 ** 32) & 0xff;
  buf[2] = (now / 2 ** 24) & 0xff;
  buf[3] = (now / 2 ** 16) & 0xff;
  buf[4] = (now / 2 ** 8) & 0xff;
  buf[5] = now & 0xff;

  // Version 7 in the high nibble of byte 6; low nibble + byte 7 random.
  buf[6] = 0x70 | (rand[0] & 0x0f);
  buf[7] = rand[1];
  // Variant (10xx) in the top two bits of byte 8.
  buf[8] = 0x80 | (rand[2] & 0x3f);
  buf[9] = rand[3];
  buf[10] = rand[4];
  buf[11] = rand[5];
  buf[12] = rand[6];
  buf[13] = rand[7];
  buf[14] = rand[8];
  buf[15] = rand[9];

  const hex = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Generate an 8-char hex id suitable for a session entry. Optionally takes a
 * `byId` set to check against — matches coding-agent's generateId collision
 * retry loop so two harnesses produce id-shape-compatible entries.
 */
export function generateEntryId(byId?: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    if (!byId || !byId.has(id)) return id;
  }
  return crypto.randomUUID();
}
