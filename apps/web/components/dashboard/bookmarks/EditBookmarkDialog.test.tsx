// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { EditBookmarkDialog } from "./EditBookmarkDialog";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@/lib/clientConfig", () => ({
  useClientConfig: () => ({ demoMode: false }),
}));
vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@karakeep/shared-react/hooks/bookmarks", () => ({
  useUpdateBookmark: () => ({ mutate: mocks.update, isPending: false }),
}));
vi.mock("@karakeep/shared-react/trpc", () => ({
  useTRPC: () => ({ bookmarks: { getBookmark: { queryOptions: () => ({}) } } }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("./BookmarkTagsEditor", () => ({ BookmarkTagsEditor: () => null }));

const bookmark: ZBookmark = {
  id: "post",
  userId: "owner",
  createdAt: new Date(),
  modifiedAt: null,
  archived: false,
  favourited: false,
  taggingStatus: null,
  summarizationStatus: null,
  embeddingStatus: null,
  tags: [],
  assets: [],
  title: "Stories • Instagram",
  titleSource: "captured",
  content: { type: BookmarkTypes.LINK, url: "https://instagram.com/p/example" },
  mediaAi: {
    runId: "one",
    fingerprint: "originals",
    model: "test",
    status: "success",
    updatedAt: new Date().toISOString(),
    allowPreview: false,
    result: {
      title: "Studio portrait",
      summary: "A studio portrait.",
      tags: ["portrait"],
    },
  },
};

afterEach(cleanup);
beforeEach(() => mocks.update.mockClear());

test("editing a note does not send the displayed AI title as a manual override", async () => {
  render(<EditBookmarkDialog open setOpen={vi.fn()} bookmark={bookmark} />);
  expect(
    (screen.getByLabelText("common.title") as HTMLInputElement).value,
  ).toBe("Studio portrait");
  fireEvent.change(screen.getByLabelText("common.note"), {
    target: { value: "Remember this" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "bookmark_editor.save_changes" }),
  );
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.update.mock.calls[0][0]).toMatchObject({
    note: "Remember this",
    title: undefined,
    titleSource: undefined,
  });
});

test("editing the title explicitly marks it as manual", async () => {
  render(<EditBookmarkDialog open setOpen={vi.fn()} bookmark={bookmark} />);
  fireEvent.change(screen.getByLabelText("common.title"), {
    target: { value: "My reference" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "bookmark_editor.save_changes" }),
  );
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My reference", titleSource: "manual" }),
    ),
  );
});

test("choosing the saved AI title only changes provenance and preserves the stored name", () => {
  render(
    <EditBookmarkDialog
      open
      setOpen={vi.fn()}
      bookmark={{ ...bookmark, titleSource: "unknown" }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "bookmark_editor.use_ai_title: Studio portrait",
    }),
  );
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    bookmarkId: "post",
    titleSource: "captured",
  });
});

test("choosing the AI title cannot discard unsaved form edits", () => {
  render(
    <EditBookmarkDialog
      open
      setOpen={vi.fn()}
      bookmark={{ ...bookmark, titleSource: "unknown" }}
    />,
  );
  fireEvent.change(screen.getByLabelText("common.note"), {
    target: { value: "Unsaved note" },
  });
  const button = screen.getByRole("button", {
    name: "bookmark_editor.use_ai_title: Studio portrait",
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(mocks.update).not.toHaveBeenCalled();
});
