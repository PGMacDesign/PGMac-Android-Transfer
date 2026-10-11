/**
 * The token as it travels in `Authorization: Bearer` and the `token.` WebSocket subprotocol.
 * A configured `API_TOKEN` can hold any character, but a subprotocol may only use HTTP token
 * characters and a header value only Latin-1 without line breaks. Percent-encoding (plus the
 * parentheses `encodeURIComponent` leaves alone) is reversible and leaves letters, digits and
 * `-_.!~*'` as they are, so a generated hex token goes over the wire unchanged.
 */
export function encodeWireToken(token: string): string {
  return encodeURIComponent(token).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
}

/** Undefined for a value that isn't valid percent-encoding. */
export function decodeWireToken(wire: string): string | undefined {
  try {
    return decodeURIComponent(wire);
  } catch {
    return undefined;
  }
}
