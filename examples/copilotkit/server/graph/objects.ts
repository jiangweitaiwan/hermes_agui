import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GoogleAuth } from "google-auth-library";
import { safePath } from "./wiki-store";

export interface GraphObject {
  key: string;
  generation: string;
  hash: string;
  size: number;
}

export interface GraphObjects {
  create(key: string, content: Buffer): Promise<GraphObject>;
  read(object: GraphObject): Promise<Buffer>;
}

const MAX_OBJECT_BYTES = 1048576;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function validateKey(key: string) {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*(?:\.md)?$/.test(key)) throw new Error("Invalid Graph object key");
}
function validateSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_OBJECT_BYTES) throw new Error("Invalid Graph object size");
}
function verify(object: GraphObject, bytes: Buffer) {
  if (object.size !== bytes.length || object.hash !== hash(bytes)) throw new Error("Graph object integrity mismatch");
  return bytes;
}

export class FilesystemGraphObjects implements GraphObjects {
  constructor(readonly root: string) {}
  async create(key: string, content: Buffer) {
    validateKey(key);
    validateSize(content.length);
    const target = safePath(join(this.root, key));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = safePath(join(dirname(target), randomUUID()));
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(content);
        await file.sync();
      } finally { await file.close(); }
      await link(temporary, target);
    } finally { await unlink(temporary); }
    const checksum = hash(content);
    return { key, generation: checksum, hash: checksum, size: content.length };
  }
  async read(object: GraphObject) {
    validateKey(object.key);
    validateSize(object.size);
    if (object.generation !== object.hash) throw new Error("Invalid Graph object generation");
    const file = await open(safePath(join(this.root, object.key)), "r");
    try {
      const bytes = Buffer.alloc(object.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("Truncated Graph object");
        offset += bytesRead;
      }
      if ((await file.stat()).size !== object.size) throw new Error("Invalid Graph object size");
      return verify(object, bytes);
    } finally { await file.close(); }
  }
}

export class GcsGraphObjects implements GraphObjects {
  private readonly auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/devstorage.read_write"] });

  constructor(readonly bucket: string, readonly prefix = "graph") {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error("Invalid Graph bucket");
    validateKey(prefix);
  }
  async ready() {
    await this.auth.getClient().catch(() => { throw new Error("Graph object credentials unavailable"); });
  }
  async create(key: string, content: Buffer) {
    validateKey(key);
    validateSize(content.length);
    const params = new URLSearchParams({ name: `${this.prefix}/${key}`, uploadType: "media", ifGenerationMatch: "0" });
    const client = await this.auth.getClient().catch(() => { throw new Error("Graph object credentials unavailable"); });
    const { data } = await client.request<{ generation: string; size: string }>({
      url: `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?${params}`,
      method: "POST", data: content, headers: { "Content-Type": "application/octet-stream" },
      signal: AbortSignal.timeout(15000),
    }).catch(() => { throw new Error("Graph object upload failed"); });
    if (!/^\d+$/.test(data.generation) || Number(data.size) !== content.length) throw new Error("Invalid Graph object receipt");
    return { key, generation: data.generation, hash: hash(content), size: content.length };
  }
  async read(object: GraphObject) {
    validateKey(object.key);
    validateSize(object.size);
    if (!/^\d+$/.test(object.generation)) throw new Error("Invalid Graph object generation");
    const name = encodeURIComponent(`${this.prefix}/${object.key}`);
    const params = new URLSearchParams({ alt: "media", generation: object.generation, ifGenerationMatch: object.generation });
    const client = await this.auth.getClient().catch(() => { throw new Error("Graph object credentials unavailable"); });
    const { data } = await client.request<ReadableStream<Uint8Array>>({
      url: `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${name}?${params}`,
      responseType: "stream", signal: AbortSignal.timeout(15000),
    }).catch(() => { throw new Error("Graph object download failed"); });
    const reader = data.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > object.size) throw new Error("Invalid Graph object size");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    return verify(object, Buffer.concat(chunks));
  }
}
