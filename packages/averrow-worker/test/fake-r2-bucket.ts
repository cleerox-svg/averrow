/**
 * In-memory R2 bucket fake (head / get / put / delete) with customMetadata,
 * enough for feeds that keep a snapshot object in R2. `put` accepts the
 * value shapes the Workers runtime does that tests actually use (string,
 * ArrayBuffer, ArrayBufferView, Blob).
 */

export interface FakeR2Entry {
  bytes: Uint8Array;
  customMetadata: Record<string, string>;
}

export interface FakeR2Bucket {
  bucket: R2Bucket;
  store: Map<string, FakeR2Entry>;
  ops: { head: number; get: number; put: number; delete: number };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Pull-based, odd-sized chunks: small objects still split across chunk
  // boundaries (exercising line reassembly), large ones aren't enqueued all
  // at once (a huge pre-filled queue makes dequeue quadratic in Node).
  const step = Math.max(7, Math.min(4093, Math.ceil(bytes.length / 16)));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(i, i + step));
      i += step;
    },
  });
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value === null || value === undefined) return new Uint8Array(0);
  throw new Error("fake R2: unsupported put value");
}

export function fakeR2Bucket(seed: Record<string, FakeR2Entry> = {}): FakeR2Bucket {
  const store = new Map<string, FakeR2Entry>(Object.entries(seed));
  const ops = { head: 0, get: 0, put: 0, delete: 0 };
  const meta = (key: string, e: FakeR2Entry) => ({
    key,
    size: e.bytes.length,
    customMetadata: { ...e.customMetadata },
  });
  const bucket = {
    async head(key: string) {
      ops.head++;
      const e = store.get(key);
      return e ? meta(key, e) : null;
    },
    async get(key: string) {
      ops.get++;
      const e = store.get(key);
      if (!e) return null;
      return {
        ...meta(key, e),
        get body() { return streamOf(e.bytes); },
        async arrayBuffer() { return e.bytes.slice().buffer; },
      };
    },
    async put(key: string, value: unknown, options?: { customMetadata?: Record<string, string> }) {
      ops.put++;
      const e = { bytes: await toBytes(value), customMetadata: { ...(options?.customMetadata ?? {}) } };
      store.set(key, e);
      return meta(key, e);
    },
    async delete(key: string) {
      ops.delete++;
      store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store, ops };
}

/** gzip a string (the snapshot encoding). */
export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gunzip bytes back to a string. */
export async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}
