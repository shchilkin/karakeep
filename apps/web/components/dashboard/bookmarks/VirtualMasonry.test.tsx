// @vitest-environment jsdom
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VirtualMasonry from "./VirtualMasonry";

// Three viewport heights, two boundary rows and at most one pinned card: 61.
const ids = Array.from({ length: 1000 }, (_, i) => String(i));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = this.hasAttribute("data-virtual-grid")
        ? -(this.closest("main")?.scrollTop ?? 0)
        : 0;
      return new DOMRect(0, top, 900, 600);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("unmounts offscreen cards, keeps the focused card, and handles a shorter result set", async () => {
  const item = (id: string) => <div data-card={id}>{id}</div>;
  const tree = (items: string[], focus = -1) => (
    <main style={{ overflowY: "auto" }}>
      <VirtualMasonry
        ids={items}
        columns={3}
        estimateHeight={100}
        focusedIndex={focus}
        renderItem={item}
      />
    </main>
  );
  const { container, rerender } = render(tree(ids));
  expect(container.querySelectorAll("[data-card]").length).toBeLessThanOrEqual(
    61,
  );
  const main = container.querySelector("main")!;
  main.scrollTop = 20000;
  fireEvent.scroll(main);
  await waitFor(() =>
    expect(container.querySelector('[data-card="0"]')).toBeNull(),
  );
  expect(container.querySelectorAll("[data-card]").length).toBeLessThanOrEqual(
    61,
  );
  rerender(tree(ids, 950));
  expect(container.querySelector('[data-card="950"]')).not.toBeNull();
  main.scrollTop = 0;
  fireEvent.scroll(main);
  await waitFor(() =>
    expect(container.querySelector('[data-card="0"]')).not.toBeNull(),
  );
  rerender(tree(ids.slice(0, 20)));
  expect(container.querySelector('[data-card="950"]')).toBeNull();
  expect(container.querySelectorAll("[data-card]").length).toBeLessThanOrEqual(
    20,
  );
});

function EditableCard({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Edit {id}</button>
      {open && createPortal(<input aria-label="Modal draft" />, document.body)}
    </div>
  );
}

it("preserves mounted card columns when new bookmarks arrive and old ones are removed", () => {
  const items = Array.from({ length: 12 }, (_, i) => String(i));
  const tree = (ids: string[]) => (
    <VirtualMasonry
      ids={ids}
      columns={3}
      estimateHeight={(id, width) => width * (Number(id) % 3 === 0 ? 1.5 : 0.5)}
      renderItem={(id) => <div>{id}</div>}
    />
  );
  const { container, rerender } = render(tree(items));
  const positions = () =>
    new Map(
      [...container.querySelectorAll<HTMLElement>("[data-virtual-id]")].map(
        (node) => [node.dataset.virtualId!, node.dataset.masonryColumn!],
      ),
    );
  const before = positions();
  rerender(tree(["new", ...items.filter((id) => id !== "2"), "older"]));
  const after = positions();
  for (const [id, column] of before)
    if (after.has(id)) expect(after.get(id)).toBe(column);
  expect(after.has("new")).toBe(true);
  expect(after.has("2")).toBe(false);
});
it("retains an active portal editor when its card scrolls away", async () => {
  const { container } = render(
    <main style={{ overflowY: "auto" }}>
      <VirtualMasonry
        ids={ids}
        columns={3}
        estimateHeight={100}
        renderItem={(id) => <EditableCard id={id} />}
      />
    </main>,
  );
  // Portal interactions bubble through their owning card in the React tree.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Edit 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit 1" }));
  const draft = screen.getByRole("textbox", {
    name: "Modal draft",
  }) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: "Do not lose this edit" } });
  const main = container.querySelector("main")!;
  main.scrollTop = 20000;
  fireEvent.scroll(main);
  await waitFor(() =>
    expect(container.querySelector('[data-virtual-id="0"]')).toBeNull(),
  );
  expect(screen.getByRole("textbox", { name: "Modal draft" })).toBe(draft);
  expect(draft.value).toBe("Do not lose this edit");
  expect(
    container.querySelectorAll("[data-virtual-id]").length,
  ).toBeLessThanOrEqual(61);
});
