import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const temporary = await mkdtemp(path.join(tmpdir(), "karakeep-media-browser-"));
const errors = [],
  mediaEvents = [];
let server, browser;
try {
  const generated = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x100:d=1:r=10",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    path.join(temporary, "clip.mp4"),
  ]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const video = await readFile(path.join(temporary, "clip.mp4"));
  const pixels = randomFillSync(Buffer.alloc(2400 * 1600 * 3));
  const original = await sharp(pixels, {
    raw: { width: 2400, height: 1600, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  const thumbnails = new Map();
  for (const width of [96, 320, 640, 1280])
    thumbnails.set(
      width,
      await sharp(original).resize({ width }).webp({ quality: 78 }).toBuffer(),
    );
  let videoRequests = 0,
    originalRequests = 0,
    thumbnailRequests = 0;
  server = await createServer({
    root: here,
    configFile: false,
    publicDir: false,
    esbuild: { jsx: "automatic" },
    resolve: {
      alias: [
        { find: "@/lib/i18n/client", replacement: path.join(here, "i18n.ts") },
        { find: "next/image", replacement: path.join(here, "image.tsx") },
        {
          find: "@karakeep/shared/utils/assetUtils",
          replacement: path.join(repo, "packages/shared/utils/assetUtils.ts"),
        },
        { find: "@", replacement: path.join(repo, "apps/web") },
      ],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
    plugins: [
      {
        name: "synthetic-media",
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            const url = new URL(req.url, "http://fixture");
            if (!url.pathname.startsWith("/api/assets/")) return next();
            let bytes, type;
            if (url.pathname.includes("/thumbnail")) {
              thumbnailRequests++;
              bytes = thumbnails.get(Number(url.searchParams.get("width")));
              type = "image/webp";
            } else if (url.pathname.includes("/video-")) {
              videoRequests++;
              bytes = video;
              type = "video/mp4";
            } else {
              originalRequests++;
              bytes = original;
              type = "image/jpeg";
            }
            if (!bytes) {
              res.writeHead(404);
              res.end();
              return;
            }
            res.setHeader("Content-Type", type);
            res.setHeader(
              "Cache-Control",
              "private, max-age=31536000, immutable",
            );
            res.setHeader("Accept-Ranges", "bytes");
            if (req.headers.range) {
              const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
              const start = Number(match[1]),
                end = Math.min(
                  match[2] ? Number(match[2]) : bytes.length - 1,
                  bytes.length - 1,
                );
              res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
                "Content-Length": end - start + 1,
              });
              res.end(bytes.subarray(start, end + 1));
            } else {
              res.setHeader("Content-Length", bytes.length);
              res.end(bytes);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Media.enable");
  await cdp.send("Performance.enable");
  cdp.on("Media.playerEventsAdded", (event) =>
    mediaEvents.push(...event.events.map((e) => e.value)),
  );
  const snapshot = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return {
      heap: await cdp.send("Runtime.getHeapUsage"),
      dom: await cdp.send("Memory.getDOMCounters"),
      videos: await page.locator("video").count(),
    };
  };
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(url);
  await page.locator("[data-card='999']").waitFor({ state: "attached" });
  await page.waitForTimeout(500);
  assert.equal(await page.locator("video").count(), 0);
  assert.equal(videoRequests, 0);
  assert.equal(originalRequests, 0);
  const idle = await snapshot();
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const card = page.locator(`[data-card='${i % 20}']`);
    await card.hover();
    await page.waitForFunction(
      () => document.querySelectorAll("video").length === 1,
    );
    await card.click();
    await page.locator("[data-viewer]").waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("video").length === 1 &&
        !!document.querySelector("[data-viewer] video"),
    );
    await page.locator("[data-viewer] video").evaluate((v) => v.play());
    await page.getByRole("button", { name: "Next item", exact: true }).click();
    assert.equal(await page.locator("video").count(), 0);
    await page.getByRole("button", { name: "Close fixture viewer" }).click();
    await page.mouse.move(0, 0);
    await page.waitForFunction(
      () => document.querySelectorAll("video").length === 0,
    );
    if ([9, 49, 99].includes(i)) {
      samples.push({ cycles: i + 1, ...(await snapshot()) });
      console.log(JSON.stringify({ progress: i + 1, videos: 0 }));
    }
  }
  await page.locator("[data-card='999']").scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("video").count(), 0);
  assert.equal(
    originalRequests,
    0,
    "Normal cards/viewer must not request full-sized images",
  );
  assert.deepEqual(errors, []);
  assert(
    samples.at(-1).dom.nodes < samples[0].dom.nodes + 100,
    "DOM nodes grow with repeated viewing",
  );
  assert(
    samples.at(-1).dom.jsEventListeners < samples[0].dom.jsEventListeners + 25,
    "Event listeners grow with repeated viewing",
  );
  assert(
    samples.at(-1).heap.usedSize < samples[0].heap.usedSize + 8 * 1024 * 1024,
    "JS heap grows with repeated viewing",
  );
  const mediaEventCounts = {};
  for (const value of mediaEvents) {
    const event = JSON.parse(value).event;
    mediaEventCounts[event] = (mediaEventCounts[event] ?? 0) + 1;
  }
  assert(mediaEventCounts.kWebMediaPlayerCreated > 0);
  assert.equal(
    mediaEventCounts.kWebMediaPlayerCreated,
    mediaEventCounts.kWebMediaPlayerDestroyed,
    "Native media players remain allocated",
  );
  const result = {
    cards: 1000,
    cycles: 100,
    browser: browser.version(),
    idle,
    samples,
    requests: {
      video: videoRequests,
      original: originalRequests,
      thumbnail: thumbnailRequests,
    },
    fixtureImageBytes: {
      original: original.length,
      thumbnail640: thumbnails.get(640).length,
    },
    mediaEventCounts,
    errors,
  };
  await writeFile(
    process.argv[2] ?? path.join(temporary, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
