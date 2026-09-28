// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { afterEach, expect, test } from "vitest";
import superjson from "superjson";
import { TRPCProvider } from "@karakeep/shared-react/trpc";
import type { AppRouter } from "@karakeep/trpc/routers/_app";
import type { LocalCheckBatchView } from "@karakeep/shared/types/importLocalCheckBatch";
import { i18n } from "@/lib/i18n/client";
import ImportLocalCheckBatches from "./ImportLocalCheckBatches";

afterEach(cleanup);
test("reviews local-only scope before start, then pauses and resumes through the API", async () => {
  await i18n.changeLanguage("en");
  let batch: LocalCheckBatchView | undefined;
  const requests: { path: string; input: unknown }[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Fake only the HTTP service. Real tRPC hooks, query cache and controls run.
  const trpc = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "https://test.invalid/api/trpc",
        transformer: superjson,
        fetch: async (url, options) => {
          const address = new URL(String(url));
          const name = address.pathname.split("/").at(-1)!;
          const rawInput = options?.body ?? address.searchParams.get("input");
          const input = rawInput
            ? superjson.parse(String(rawInput))
            : undefined;
          requests.push({ path: name, input });
          let value: unknown;
          if (name === "deferredImport.localCheckBatches")
            value = batch ? [batch] : [];
          else if (name === "deferredImport.prepareLocalCheckBatch") {
            batch = {
              id: "e1da01af-172a-4f19-b56d-e581472240ca",
              status: "draft",
              createdAt: 1,
              total: 8500,
              counts: {
                ready: 8000,
                released: 0,
                complete: 0,
                failed: 0,
                skipped: 500,
              },
              outcomeReasons: { already_checked: 500 },
            };
            value = batch;
          } else if (name === "deferredImport.changeLocalCheckBatch") {
            const action = (input as { action: string }).action;
            batch = {
              ...batch!,
              status: action === "pause" ? "paused" : "running",
            };
            value = batch;
          } else if (name === "deferredImport.localCheckBatchItems") {
            value = {
              total: 8500,
              items: [
                {
                  bookmarkId: "checked-image",
                  state: "complete",
                  reason: null,
                },
              ],
            };
          } else throw new Error(`Unexpected HTTP operation: ${name}`);
          return new Response(
            JSON.stringify({ result: { data: superjson.serialize(value) } }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
    ],
  });
  render(
    <QueryClientProvider client={client}>
      <TRPCProvider trpcClient={trpc} queryClient={client}>
        <ImportLocalCheckBatches selectedIds={["selected-image"]} />
      </TRPCProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Review all imported images" }),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByText(/ShieldGemma only/)).toBeTruthy();
  expect(
    screen.getByText(/Existing titles and source tags will also be indexed/),
  ).toBeTruthy();
  expect(
    requests.filter((r) => r.path.endsWith("changeLocalCheckBatch")),
  ).toHaveLength(0);
  expect(
    requests.find((r) => r.path.endsWith("prepareLocalCheckBatch"))?.input,
  ).toMatchObject({ selection: { type: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "Start local checks" }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Resume remaining" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
  );
  expect(
    requests
      .filter((r) => r.path.endsWith("changeLocalCheckBatch"))
      .map((r) => r.input),
  ).toEqual([
    { id: batch!.id, action: "start" },
    { id: batch!.id, action: "pause" },
    { id: batch!.id, action: "resume" },
  ]);
  expect(
    requests.filter((r) => r.path.endsWith("localCheckBatchItems")),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Show cards" }));
  expect(
    await screen.findByRole("link", { name: "checked-image" }),
  ).toBeTruthy();
  expect(
    requests.find((r) => r.path.endsWith("localCheckBatchItems"))?.input,
  ).toMatchObject({ id: batch!.id, limit: 50, offset: 0 });
  client.clear();
});
