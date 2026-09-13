// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import AiQueueDialog from "./AiQueueDialog";

const server = vi.hoisted(() => ({ prepare: vi.fn(), start: vi.fn() }));
vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@karakeep/shared-react/trpc", () => ({
  useTRPC: () => ({
    ai: {
      configuration: {
        queryOptions: (_: unknown, options: object) => ({
          queryKey: ["ai", "config"],
          queryFn: async () => ({
            enabled: true,
            provider: "xai",
            model: "vision-1",
            cloudMode: "off",
            localEnabled: true,
            localModel: "local-vision",
          }),
          ...options,
        }),
      },
      prepare: { mutationOptions: () => ({ mutationFn: server.prepare }) },
      changeBatch: {
        mutationOptions: (options: object) => ({
          mutationFn: server.start,
          ...options,
        }),
      },
      pathKey: () => ["ai"],
    },
    bookmarks: { pathKey: () => ["bookmarks"] },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  server.prepare.mockImplementation(async (request) => ({
    id: request.requestId,
    mode: request.mode,
    previousPaidAttempts: 0,
    entries: [
      { bookmarkId: "one", title: "Synthetic ready card", status: "ready" },
      {
        bookmarkId: "two",
        title: "Synthetic held import",
        status: "skipped",
        reason: "import_held",
      },
    ],
  }));
  server.start.mockResolvedValue({ status: "running" });
});
afterEach(cleanup);
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AiQueueDialog
        open
        onOpenChange={() => undefined}
        selection={{ type: "ids", ids: ["one", "two"] }}
      />
    </QueryClientProvider>,
  );
}
test("reviews fixed selection and skip reasons before explicitly starting the batch", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "ai_control.review_batch" }),
  );
  expect(await screen.findByText("Synthetic held import")).toBeTruthy();
  expect(screen.getByText("ai_control.reasons.import_held")).toBeTruthy();
  expect(server.start).not.toHaveBeenCalled();
  expect(server.prepare.mock.calls[0][0]).toMatchObject({
    selection: { type: "ids", ids: ["one", "two"] },
    mode: "hybrid",
    model: "vision-1",
    action: "analyze",
  });
  fireEvent.click(screen.getByRole("button", { name: "ai_control.enqueue" }));
  await waitFor(() => expect(server.start).toHaveBeenCalledOnce());
  expect(server.start.mock.calls[0][0]).toEqual({
    id: server.prepare.mock.calls[0][0].requestId,
    action: "start",
  });
  expect(
    await screen.findByRole("link", { name: "ai_control.open_queue" }),
  ).toBeTruthy();
});
test("local-only confirmation does not present a cloud charge estimate", async () => {
  mount();
  fireEvent.change(await screen.findByRole("combobox"), {
    target: { value: "local" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "ai_control.review_batch" }),
  );
  expect(await screen.findByText("ai_control.confirm_local")).toBeTruthy();
  expect(screen.queryByText("ai_control.confirm_cost")).toBeNull();
  expect(server.prepare.mock.calls[0][0].mode).toBe("local");
});
