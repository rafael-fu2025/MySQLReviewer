/**
 * Identifier generator that works in insecure contexts.
 *
 * `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost).
 * Over plain-HTTP LAN sharing (`start-lan.bat`) the API is missing entirely,
 * which used to crash the workspace at load — so fall back to a
 * `getRandomValues`-based UUID v4, which every browser provides.
 */
export function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
