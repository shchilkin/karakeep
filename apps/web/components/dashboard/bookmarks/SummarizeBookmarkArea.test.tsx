// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import SummarizeBookmarkArea from "./SummarizeBookmarkArea";

const mocks = vi.hoisted(() => ({ summarize: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/clientConfig", () => ({
  useClientConfig: () => ({
    mediaAi: { enabled: true },
    inference: { isConfigured: true },
  }),
}));
vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@karakeep/shared-react/hooks/bookmarks", () => ({
  useSummarizeBookmark: () => ({ mutate: mocks.summarize, isPending: false }),
  useUpdateBookmark: () => ({ mutate: mocks.update, isPending: false }),
}));
vi.mock("@karakeep/shared-react/trpc", () => ({
  useTRPC: () => ({
    bookmarks: {
      analyzeMedia: { mutationOptions: (options: unknown) => options },
      pathKey: () => ["bookmarks"],
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/ui/markdown/markdown-readonly", () => ({
  MarkdownReadonly: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

function article(overrides: Partial<ZBookmark> = {}): ZBookmark {
  return {
    id: "article",
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
    content: {
      type: BookmarkTypes.LINK,
      url: "https://example.test/article",
      imageAssetId: "preview",
    },
    ...overrides,
  };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("articles with previews retain text summarization alongside explicit preview analysis", () => {
  render(<SummarizeBookmarkArea bookmark={article()} />);
  fireEvent.click(
    screen.getByRole("button", { name: "actions.summarize_with_ai" }),
  );
  expect(mocks.summarize).toHaveBeenCalledWith({ bookmarkId: "article" });
  expect(
    screen.getByRole("button", { name: "media_ai.analyze_preview" }),
  ).toBeTruthy();
});

test("an existing article summary retains Markdown and its expanded controls", () => {
  render(
    <SummarizeBookmarkArea
      bookmark={article({ summary: "**Article summary**" })}
    />,
  );
  expect(screen.getByTestId("markdown").textContent).toBe(
    "**Article summary**",
  );
  expect(screen.getAllByText("**Article summary**")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("markdown"));
  expect(screen.getAllByRole("button", { name: "Collapse" })).toHaveLength(3);
  expect(
    screen.getByRole("button", { name: "media_ai.analyze_preview" }),
  ).toBeTruthy();
});

test("saved originals use the media workflow without the article summarizer", () => {
  render(
    <SummarizeBookmarkArea
      bookmark={article({
        assets: [
          { id: "original", assetType: "userUploaded", fileName: "001.jpg" },
        ],
      })}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "actions.summarize_with_ai" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "media_ai.analyze" })).toBeTruthy();
});
