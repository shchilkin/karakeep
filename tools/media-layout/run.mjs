import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const temp = await mkdtemp(path.join(tmpdir(), "karakeep-layout-"));
const css = path.join(temp, "style.css");
const compile = spawnSync(
  process.execPath,
  [
    path.join(repo, "node_modules/tailwindcss/lib/cli.js"),
    "-c",
    path.join(repo, "apps/web/tailwind.config.ts"),
    "-i",
    path.join(repo, "tooling/tailwind/globals.css"),
    "--content",
    [
      path.join(here, "main.tsx"),
      path.join(repo, "apps/web/components/dashboard/bookmarks/*tsx"),
      path.join(repo, "apps/web/components/ui/*tsx"),
    ].join(","),
    "-o",
    css,
  ],
  { cwd: repo },
);
assert.equal(compile.status, 0, compile.stderr.toString());
const styles = await readFile(css);
let server, browser;
let failPhoto = false;
const errors = [];
const cycles = [];
try {
  server = await createServer({
    root: here,
    configFile: false,
    esbuild: { jsx: "automatic" },
    resolve: {
      alias: [
        {
          find: "@/lib/i18n/client",
          replacement: path.join(repo, "tools/media-performance/i18n.ts"),
        },
        { find: "@", replacement: path.join(repo, "apps/web") },
      ],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
    plugins: [
      {
        name: "layout-media",
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url === "/style.css") {
              res.setHeader("Content-Type", "text/css");
              res.end(styles);
              return;
            }
            const match = /^\/media\/(\d+)\.svg$/.exec(req.url);
            if (!match) return next();
            const height =
              Number(match[1]) % 3 === 0
                ? 960
                : Number(match[1]) % 3 === 1
                  ? 400
                  : 640;
            setTimeout(() => {
              res.setHeader("Cache-Control", "no-store");
              if (failPhoto && match[1] === "0") {
                res.writeHead(503);
                res.end();
                return;
              }
              res.setHeader("Content-Type", "image/svg+xml");
              res.end(
                `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}"><rect width="640" height="${height}" fill="#94a3b8"/></svg>`,
              );
            }, 300);
          });
        },
      },
    ],
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  if (process.env.SERVE_ONLY) {
    console.log(url);
    await new Promise((resolve) => process.on("SIGINT", resolve));
  } else {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() =>
      [0, 1, 2].every(
        (id) =>
          document.querySelector(`[data-card="${id}"] img`)?.naturalWidth > 0,
      ),
    );
    await page.waitForTimeout(300);
    // Exercise image-memory eviction: tiny cached fixtures otherwise hide the bug.
    for (const scenario of [
      "repeat",
      "repeat",
      "resize",
      "columns",
      "error",
      "recovery",
      "mobile",
    ]) {
      if (scenario === "resize")
        await page.setViewportSize({ width: 960, height: 900 });
      if (scenario === "columns")
        await page.getByRole("button", { name: "Change columns" }).click();
      if (scenario === "mobile")
        await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(200);
      const mobile = scenario === "mobile";
      const tracked = mobile ? [0] : [0, 1, 2];
      const before = await page.evaluate(
        (ids) =>
          ids.map((id) => ({
            id,
            height: document
              .querySelector(`[data-card="${id}"]`)
              .getBoundingClientRect().height,
          })),
        tracked,
      );
      await page.evaluate((mobile) => {
        if (mobile) window.scrollTo(0, 18000);
        else document.querySelector("[data-feed]").scrollTop = 18000;
      }, mobile);
      await page.waitForFunction(
        () => !document.querySelector('[data-card="0"]'),
      );
      await page.waitForTimeout(700);
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("HeapProfiler.collectGarbage");
      failPhoto = scenario === "error";
      const samples = await page.evaluate(
        async ({ mobile, tracked }) => {
          const feed = document.querySelector("[data-feed]");
          if (mobile) window.scrollTo(0, 0);
          else feed.scrollTop = 0;
          const samples = [];
          const start = performance.now();
          while (performance.now() - start < 900) {
            await new Promise(requestAnimationFrame);
            for (const id of tracked) {
              const e = document.querySelector(`[data-card="${id}"]`);
              if (e)
                samples.push({
                  id,
                  height: e.getBoundingClientRect().height,
                  top: e.getBoundingClientRect().top,
                  scroll: mobile ? scrollY : feed.scrollTop,
                  loading:
                    e
                      .querySelector("[aria-busy]")
                      ?.getAttribute("aria-busy") === "true",
                });
            }
          }
          return samples;
        },
        { mobile, tracked },
      );
      const cards = tracked.map((id) => {
        const frames = samples.filter((s) => s.id === id);
        const heights = frames.map((s) => s.height);
        const tops = frames.map((s) => s.top);
        return {
          id,
          before: before.find((b) => b.id === id).height,
          minimum: Math.min(...heights),
          maximum: Math.max(...heights),
          delta: Math.max(...heights) - Math.min(...heights),
          topDelta: Math.max(...tops) - Math.min(...tops),
          frames: frames.length,
          loadingFrames: frames.filter((s) => s.loading).length,
        };
      });
      cycles.push({ scenario, cards });
      console.log(JSON.stringify(cycles.at(-1)));
      for (const card of cards) {
        assert(card.frames > 10, "No remount samples");
        assert(
          card.loadingFrames > 0,
          "Fixture did not exercise media reloading",
        );
        assert(
          card.delta < 1,
          "Revisiting a media card changes its height while the image reloads",
        );
        assert(
          card.topDelta < 1,
          "Media loading moves neighbouring cards or the scroll anchor",
        );
      }
      if (scenario === "error") {
        assert.equal(await page.locator('[data-card="0"] img').count(), 0);
        assert.equal(
          await page
            .locator('[data-card="0"] [aria-busy]')
            .getAttribute("aria-busy"),
          "false",
        );
      }
    }
    assert.deepEqual(errors, []);
    if (process.env.RESULT_PATH)
      await writeFile(
        process.env.RESULT_PATH,
        JSON.stringify({ cycles, errors }, null, 2),
      );
    if (process.env.SCREENSHOT_PATH)
      await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(temp, { recursive: true, force: true });
}
