/** Bound bytes while reading, including chunked requests without Content-Length. */
export async function boundedText(request: Request, limit: number) {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
