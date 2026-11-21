// The egress frames ("route traffic through this computer", vps-link-egress.mjs) as records on one byte stream, for
// the link between the app and its madani cloud home: a websocket over the home's own https. A record is a type byte, a
// 32-bit length and the payload: 0 a JSON control frame (egress, dial, dialed, end, cancel), 1 a stream's bytes with
// its 12-letter id first. The server reads the same records (server/home-egress-link.ts).

export const CONTROL = 0;
export const BYTES = 1;
/** a stream's piece is at most the egress endpoint's own chunk; a control frame is a few hundred bytes */
export const MAX_RECORD = 2 * 1024 * 1024;
const ID = /^[a-z2-7]{12}$/;

const head = (type, length) => { const out = Buffer.allocUnsafe(5); out[0] = type; out.writeUInt32BE(length, 1); return out; };

export function encodeControl(frame) {
  const body = Buffer.from(JSON.stringify(frame));
  return Buffer.concat([head(CONTROL, body.length), body]);
}

export function encodeBytes(r, chunk) {
  if (!ID.test(r)) throw new Error("a stream id is 12 base32 letters");
  return Buffer.concat([head(BYTES, 12 + chunk.length), Buffer.from(r, "latin1"), chunk]);
}

/** frames out of the byte stream, in order; throws on a record that is not one */
export function linkReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const type = buf[0], length = buf.readUInt32BE(1);
      if ((type !== CONTROL && type !== BYTES) || length > MAX_RECORD) throw new Error("not an egress link record");
      if (buf.length < 5 + length) return;
      const body = buf.subarray(5, 5 + length);
      buf = buf.subarray(5 + length);
      if (type === CONTROL) {
        const frame = JSON.parse(body.toString("utf8"));
        if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.t !== "string" || frame.t === "bytes") throw new Error("not an egress control frame");
        onFrame(frame);
      } else {
        const r = body.subarray(0, 12).toString("latin1");
        if (!ID.test(r)) throw new Error("not an egress stream id");
        onFrame({ t: "bytes", r, b: Buffer.from(body.subarray(12)) });
      }
    }
  };
}
