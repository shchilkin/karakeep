import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/** Recomputable disk cache. One conversion at a time; duplicate requests share it. */
export class MediaPreviewCache {
  private entries = new Map<string, { size: number; created: number }>();
  private pending = new Map<string, Promise<Buffer>>();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized?: Promise<void>;
  private bytes = 0;

  constructor(
    private directory: string,
    private maxBytes = 256 * 1024 * 1024,
    private maxPending = 64,
    private maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    private extension: "webp" | "mp4" = "webp",
  ) {}

  private async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(name)) {
        await rm(path.join(this.directory, name), { force: true });
      } else if (new RegExp(`^[a-f0-9]{64}\\.${this.extension}$`).test(name)) {
        const info = await stat(path.join(this.directory, name));
        this.entries.set(name, { size: info.size, created: info.mtimeMs });
        this.bytes += info.size;
      }
    }
    await this.prune();
  }

  private async prune() {
    for (const [name, info] of [...this.entries].sort(
      (a, b) => a[1].created - b[1].created,
    )) {
      if (
        this.bytes <= this.maxBytes &&
        Date.now() - info.created <= this.maxAgeMs
      )
        break;
      await rm(path.join(this.directory, name), { force: true });
      this.entries.delete(name);
      this.bytes -= info.size;
    }
  }

  async get(identity: string, render: () => Promise<Buffer>): Promise<Buffer> {
    const name =
      createHash("sha256").update(identity).digest("hex") +
      `.${this.extension}`;
    this.initialized ??= this.initialize().catch((error) => {
      this.initialized = undefined;
      this.entries.clear();
      this.bytes = 0;
      throw error;
    });
    await this.initialized;
    // Cache hits must not wait behind a slow original being decoded.
    const entry = this.entries.get(name);
    if (entry && Date.now() - entry.created <= this.maxAgeMs) {
      try {
        return await readFile(path.join(this.directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (this.entries.get(name) === entry) {
          this.entries.delete(name);
          this.bytes -= entry.size;
        }
      }
    }
    const existing = this.pending.get(name);
    if (existing) return existing;
    if (this.pending.size >= this.maxPending) throw new PreviewBusyError();
    const job = this.queue
      .catch(() => undefined)
      .then(async () => {
        const buffer = await render();
        if (buffer.length > this.maxBytes) return buffer;
        const temporary = path.join(
          this.directory,
          `${name.slice(0, 64)}.${randomUUID()}.tmp`,
        );
        try {
          await writeFile(temporary, buffer, { mode: 0o600 });
          await rename(temporary, path.join(this.directory, name));
        } finally {
          await rm(temporary, { force: true });
        }
        this.bytes -= this.entries.get(name)?.size ?? 0;
        this.entries.set(name, { size: buffer.length, created: Date.now() });
        this.bytes += buffer.length;
        await this.prune();
        return buffer;
      });
    this.queue = job;
    this.pending.set(name, job);
    try {
      return await job;
    } finally {
      this.pending.delete(name);
    }
  }
}

export class PreviewBusyError extends Error {}
