// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mediaPlayback } from "@/lib/mediaPlayback";
import BookmarkCardVideo from "./BookmarkCardVideo";

vi.mock("./BookmarkCardImage", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- Test adapter for browser image state.
    <img src={src} alt={alt} />
  ),
}));
let reduced = false;
let intersect: (entries: { isIntersecting: boolean }[]) => void;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reduced = false;
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe() {
        /* Visibility is controlled by the test. */
      }
      disconnect() {
        /* No native observer in jsdom. */
      }
    },
  );
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function card() {
  return render(
    // eslint-disable-next-line @next/next/no-html-link-for-pages -- Isolate media behavior from the Next router.
    <a href="/dashboard/preview/post">
      <BookmarkCardVideo
        src="/api/assets/video/hover-clip"
        poster="/api/assets/poster"
        alt="Video post"
        naturalSize
      />
    </a>,
  );
}
it("loads only the poster at rest, plays muted on hover and releases video on leave", async () => {
  const { container } = card();
  expect(screen.getByAltText("Video post").getAttribute("src")).toBe(
    "/api/assets/poster",
  );
  expect(container.querySelector("video")).toBeNull();
  fireEvent.pointerEnter(screen.getByRole("link"));
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  const video = container.querySelector("video")!;
  expect(video.getAttribute("src")).toBe("/api/assets/video/hover-clip");
  expect(video.muted).toBe(true);
  expect(video.playsInline).toBe(true);
  fireEvent.pointerLeave(screen.getByRole("link"));
  expect(container.querySelector("video")).toBeNull();
  expect(pause).toHaveBeenCalledOnce();
  expect(video.getAttribute("src")).toBeNull();
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalledOnce();
});
it("stops when scrolled offscreen", async () => {
  const { container } = card();
  fireEvent.pointerEnter(screen.getByRole("link"));
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  const { act } = await import("@testing-library/react");
  act(() => intersect([{ isIntersecting: false }]));
  expect(container.querySelector("video")).toBeNull();
});
it("keeps the poster when reduced motion is requested", () => {
  reduced = true;
  const { container } = card();
  fireEvent.pointerEnter(screen.getByRole("link"));
  expect(container.querySelector("video")).toBeNull();
  expect(play).not.toHaveBeenCalled();
});
it("keeps the poster visible when autoplay is rejected", async () => {
  play.mockRejectedValue(new Error("NotAllowedError"));
  const { container } = card();
  fireEvent.pointerEnter(screen.getByRole("link"));
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  expect(
    container.querySelector("video")?.classList.contains("opacity-0"),
  ).toBe(true);
  expect(screen.getByAltText("Video post")).toBeTruthy();
});

it("does not allocate players for brief pointer passes", async () => {
  const { container } = card();
  fireEvent.pointerEnter(screen.getByRole("link"));
  fireEvent.pointerLeave(screen.getByRole("link"));
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(play).not.toHaveBeenCalled();
  expect(container.querySelector("video")).toBeNull();
});
it("revokes an existing preview when a gallery opens and blocks further hover", async () => {
  const { container } = card();
  fireEvent.pointerEnter(screen.getByRole("link"));
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  const video = container.querySelector("video")!;
  const { act } = await import("@testing-library/react");
  let close!: () => void;
  act(() => {
    close = mediaPlayback.openViewer();
  });
  try {
    expect(container.querySelector("video")).toBeNull();
    expect(video.getAttribute("src")).toBeNull();
    fireEvent.pointerLeave(screen.getByRole("link"));
    fireEvent.pointerEnter(screen.getByRole("link"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 180)));
    expect(container.querySelector("video")).toBeNull();
  } finally {
    close();
  }
});
