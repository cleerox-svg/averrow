/**
 * Bounded response-body reads for upstream fetches (feeds, ingests).
 *
 * `res.text()` buffers whatever the upstream sends; a misbehaving or
 * hostile server can push an arbitrarily large body into the isolate.
 * These helpers stop reading (and cancel the stream) past a byte cap.
 */

/** Read a body as text, giving up (null) once it exceeds maxBytes. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}
