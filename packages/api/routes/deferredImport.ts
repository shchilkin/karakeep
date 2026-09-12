import { zReleaseImport } from "@karakeep/shared/types/importProcessing";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import {
  MAX_IMPORT_METADATA_BYTES,
  zImportFence,
  zImportReservation,
} from "@karakeep/shared/types/deferredImport";
import {
  readImportMetadata,
  uploadImportFile,
  uploadImportMetadata,
} from "@karakeep/trpc/models/deferredImport";
import { authMiddleware } from "../middlewares/auth";
import { apiKeyScopeMiddleware } from "../middlewares/apiKeyScopes";
import { rejectMutationInReadOnlyMode } from "../middlewares/readOnlyMode";
const read = apiKeyScopeMiddleware("imports", "read");
const write = apiKeyScopeMiddleware("imports", "readwrite");
const manifestLimit = bodyLimit({ maxSize: 256 * 1024 });
function inputStream(body: ReadableStream<Uint8Array> | null) {
  if (!body)
    throw new HTTPException(400, { message: "Original bytes are required." });
  return Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
}
async function metadataBytes(body: ReadableStream<Uint8Array> | null) {
  const source = inputStream(body);
  let size = 0;
  const chunks: Buffer[] = [];
  const timer = setTimeout(
    () => source.destroy(new Error("Metadata upload deadline exceeded")),
    20_000,
  );
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > MAX_IMPORT_METADATA_BYTES)
        throw new HTTPException(413, {
          message: "Metadata exceeds the byte limit.",
        });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
}
function fence(header: string | undefined) {
  const value = Number(header);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new HTTPException(400, { message: "X-Import-Fence is required." });
  return value;
}
export default new Hono()
  .use(authMiddleware)
  .get("/reservations/:id/processing", read, async (c) =>
    c.json(
      await c.var.api.deferredImport.processing({ id: c.req.param("id") }),
    ),
  )
  .post(
    "/reservations/:id/release",
    write,
    rejectMutationInReadOnlyMode,
    manifestLimit,
    zValidator("json", zReleaseImport),
    async (c) =>
      c.json(
        await c.var.api.deferredImport.release({
          id: c.req.param("id"),
          ...c.req.valid("json"),
        }),
      ),
  )
  .get("/capabilities", read, async (c) =>
    c.json(await c.var.api.deferredImport.capabilities()),
  )
  .post(
    "/lookup",
    read,
    manifestLimit,
    zValidator("json", zImportReservation),
    async (c) =>
      c.json(await c.var.api.deferredImport.lookup(c.req.valid("json"))),
  )
  .post(
    "/reservations",
    write,
    rejectMutationInReadOnlyMode,
    manifestLimit,
    zValidator("json", zImportReservation),
    async (c) =>
      c.json(
        await c.var.api.deferredImport.reserve({
          idempotencyKey: c.req.header("Idempotency-Key") ?? "",
          payload: c.req.valid("json"),
        }),
      ),
  )
  .get("/reservations/:id", read, async (c) =>
    c.json(await c.var.api.deferredImport.status({ id: c.req.param("id") })),
  )
  .get(
    "/reservations/:id/metadata",
    read,
    (c) =>
      new Response(
        new Uint8Array(readImportMetadata(c.var.ctx, c.req.param("id"))),
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment; filename=source-metadata.json",
            "Cache-Control": "private, no-store",
          },
        },
      ),
  )
  .put(
    "/reservations/:id/metadata",
    write,
    rejectMutationInReadOnlyMode,
    async (c) => {
      // Authenticate the operation before accepting an arbitrary byte body.
      await c.var.api.deferredImport.status({ id: c.req.param("id") });
      return c.json(
        await uploadImportMetadata(
          c.var.ctx,
          c.req.param("id"),
          fence(c.req.header("X-Import-Fence")),
          await metadataBytes(c.req.raw.body),
        ),
      );
    },
  )
  .put(
    "/reservations/:id/files/:slot",
    write,
    rejectMutationInReadOnlyMode,
    async (c) =>
      c.json(
        await uploadImportFile(
          c.var.ctx,
          c.req.param("id"),
          c.req.param("slot"),
          fence(c.req.header("X-Import-Fence")),
          inputStream(c.req.raw.body),
        ),
      ),
  )
  .post(
    "/reservations/:id/verify",
    write,
    rejectMutationInReadOnlyMode,
    manifestLimit,
    zValidator("json", zImportFence),
    async (c) =>
      c.json(
        await c.var.api.deferredImport.verify({
          id: c.req.param("id"),
          ...c.req.valid("json"),
        }),
      ),
  )
  .post(
    "/reservations/:id/commit",
    write,
    rejectMutationInReadOnlyMode,
    manifestLimit,
    zValidator("json", zImportFence),
    async (c) =>
      c.json(
        await c.var.api.deferredImport.commit({
          id: c.req.param("id"),
          ...c.req.valid("json"),
        }),
      ),
  );
