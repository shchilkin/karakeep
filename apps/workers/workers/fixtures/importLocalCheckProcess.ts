// Isolated process fixture: real worker/queue/database lifecycle; only the
// external search service is replaced. The classifier is a loopback HTTP server.
import type { SearchIndexClient } from "@karakeep/shared/search";
import { mock } from "node:test";

const offset = Number(process.env.TEST_CLOCK_OFFSET_MS ?? 0);
if (offset) mock.timers.enable({ apis: ["Date"], now: Date.now() + offset });
const endpoint = process.env.TEST_SERVICES_URL!;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url !== `${endpoint}/check` && url !== `${endpoint}/index`) {
    process.send?.({ type: "unexpected-request", url });
    throw new Error("External network access forbidden in restart fixture");
  }
  return realFetch(input, init);
};

const { db } = await import("@karakeep/db");
const { loadAllPlugins } = await import("@karakeep/shared-server");
const { PluginManager, PluginType } = await import("@karakeep/shared/plugins");
const { getQueueClient } = await import("@karakeep/shared/queueing");
const { MediaCatalogQueue } = await import("@karakeep/shared-server");
const { ImportProcessingWorker } = await import("../importProcessingWorker");
const { MediaCatalogWorker } = await import("../inference/mediaCatalogWorker");
await loadAllPlugins();
const search: SearchIndexClient = {
  async addDocuments(docs) {
    const response = await fetch(`${endpoint}/index`, {
      method: "POST",
      body: JSON.stringify(docs),
    });
    if (!response.ok) throw new Error("Test search service failed");
  },
  async deleteDocuments() {
    process.send?.({
      type: "unexpected-request",
      url: "search.deleteDocuments",
    });
    throw new Error("Unexpected search deletion");
  },
  async clearIndex() {
    process.send?.({ type: "unexpected-request", url: "search.clearIndex" });
    throw new Error("Unexpected search clearing");
  },
  async search() {
    const response = await fetch(`${endpoint}/index`);
    const ids: string[] = await response.json();
    return {
      hits: ids.map((id) => ({ id })),
      totalHits: ids.length,
      processingTimeMs: 0,
    };
  },
};
PluginManager.register({
  type: PluginType.Search,
  name: "Restart test search service",
  provider: { getClient: async () => search },
});
const queue = await getQueueClient();
await queue.prepare();
await queue.start();
await MediaCatalogQueue.ensureInit();
const workers = [await ImportProcessingWorker.build()];
if (process.env.TEST_IMPORT_ONLY !== "true")
  workers.push(await MediaCatalogWorker.build());
const running = Promise.all(workers.map((worker) => worker.run()));
process.send?.({ type: "ready" });
process.once("message", (message) => {
  if (message === "stop") workers.forEach((worker) => worker.stop());
});
await running;
await queue.shutdown?.();
db.$client.close();
mock.timers.reset();
process.disconnect();
// Like the service entry point, exit after workers drain and DB closes. Liteque
// retains completed-job timeout handles; they must not keep this fixture alive.
process.exit(0);
