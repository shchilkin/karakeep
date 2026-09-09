// @vitest-environment jsdom
/* oxlint-disable nextjs/no-img-element -- Synthetic lifecycle probe, not a product image. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { UserLocalSettingsCtx } from "@/lib/userLocalSettings/bookmarksLayout";
import { defaultUserLocalSettings } from "@/lib/userLocalSettings/types";
import { updateSensitivityMode } from "@/lib/userLocalSettings/userLocalSettings";
import type { SensitivityMode } from "@karakeep/shared/sensitiveContent";
import { SensitiveProvider, useSensitiveContent } from "./SensitiveProvider";
import SensitiveSection from "./SensitiveSection";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/sensitive",
}));
vi.mock("@/lib/userLocalSettings/userLocalSettings", () => ({
  updateSensitivityMode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: vi.fn() }));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});
const marked = {
  id: "video",
  sensitiveCategories: ["explicit_sexual"] as const,
};
function Feed() {
  const state = useSensitiveContent();
  const bookmark = {
    ...marked,
    sensitiveCategories: [...marked.sensitiveCategories],
  };
  return (
    <>
      <button onClick={() => state.setMode("work")}>work</button>
      <button onClick={() => state.setMode("balanced")}>balanced</button>
      <button onClick={() => state.setMode("all")}>all</button>
      <button onClick={() => state.reveal(bookmark)}>reveal</button>
      {state.conceal(bookmark) ? (
        <p>concealed</p>
      ) : (
        <video src="/synthetic-video.mp4" muted />
      )}
      {!state.conceal({
        id: "swimwear",
        sensitiveCategories: ["revealing_clothing"],
      }) && <img alt="swimwear fixture" src="/synthetic-photo.jpg" />}
    </>
  );
}
function Tree({
  mode = "balanced",
  section = false,
}: {
  mode?: SensitivityMode;
  section?: boolean;
}) {
  return (
    <UserLocalSettingsCtx
      value={{ ...defaultUserLocalSettings(), sensitivityMode: mode }}
    >
      <SensitiveProvider>
        {section ? (
          <SensitiveSection>
            <Feed />
          </SensitiveSection>
        ) : (
          <Feed />
        )}
      </SensitiveProvider>
    </UserLocalSettingsCtx>
  );
}
it("does not mount sensitive media during SSR or a new session with a saved show-all preference", async () => {
  expect(renderToString(<Tree mode="all" />)).not.toContain("<video");
  const { container } = render(<Tree mode="all" />);
  expect(container.querySelector("video")).toBeNull();
  fireEvent.click(screen.getByText("all"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(container.querySelector("video")).toBeNull();
  fireEvent.click(screen.getByText("actions.cancel"));
  expect(container.querySelector("video")).toBeNull();
  fireEvent.click(screen.getByText("all"));
  fireEvent.click(screen.getByText("sensitive.continue"));
  await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
  expect(updateSensitivityMode).toHaveBeenCalledWith("all");
});
it("unmounts playing media and clears individual reveals when changing mode", async () => {
  const { container } = render(<Tree />);
  expect(container.querySelector("img")).toBeTruthy();
  fireEvent.click(screen.getByText("reveal"));
  expect(container.querySelector("video")).toBeTruthy();
  fireEvent.click(screen.getByText("work"));
  await waitFor(() => expect(container.querySelector("video,img")).toBeNull());
  fireEvent.click(screen.getByText("balanced"));
  await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
  expect(container.querySelector("video")).toBeNull();
});
it("requires one section warning per session and restores the feed policy on leaving", async () => {
  const { container, rerender } = render(<Tree mode="work" section />);
  expect(container.querySelector("video,img")).toBeNull();
  fireEvent.click(screen.getByText("sensitive.open_section"));
  fireEvent.click(screen.getByText("sensitive.continue"));
  await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
  rerender(<Tree mode="work" />);
  await waitFor(() => expect(container.querySelector("video,img")).toBeNull());
  rerender(<Tree mode="work" section />);
  await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  // A page reload in the same tab remembers the confirmation.
  const next = render(<Tree mode="work" section />);
  await waitFor(() =>
    expect(next.container.querySelector("video")).toBeTruthy(),
  );
});
it("keeps the prior mode if saving preferences fails", async () => {
  vi.mocked(updateSensitivityMode).mockRejectedValueOnce(new Error("offline"));
  render(<Tree mode="work" />);
  fireEvent.click(screen.getByText("balanced"));
  await waitFor(() =>
    expect(screen.queryByAltText("swimwear fixture")).toBeNull(),
  );
});
