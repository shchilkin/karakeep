// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookmarkImage } from "@/lib/bookmarkImages";

import SavedImageGallery from "./SavedImageGallery";

vi.mock("@/lib/i18n/client", async () => {
  const { createInstance } = await import("i18next");
  const { default: en } =
    await import("@/lib/i18n/locales/en/translation.json");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  return { useTranslation: () => ({ t: i18n.t.bind(i18n) }) };
});

vi.mock("next/image", () => ({
  default: ({
    unoptimized: _unoptimized,
    fill: _fill,
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    unoptimized?: boolean;
    fill?: boolean;
    // eslint-disable-next-line @next/next/no-img-element -- Exercise browser image events in the Next Image test adapter.
  }) => <img alt={alt} {...props} />,
}));

const images: BookmarkImage[] = [1, 2, 3].map((index) => ({
  id: `photo-${index}`,
  assetType: "userUploaded",
  fileName: `photo_${index}.jpg`,
}));

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("saved photo carousel", () => {
  it("opens resized previews, navigates with buttons, and downloads the selected photo", () => {
    render(<SavedImageGallery images={images} title="A saved post" />);
    expect(
      screen.getByAltText("A saved post — photo 1 of 3").getAttribute("src"),
    ).toBe("/api/assets/photo-1/thumbnail?width=1280");
    expect(
      screen
        .getByRole("button", { name: "Previous photo" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(
      screen.getByAltText("A saved post — photo 2 of 3").getAttribute("src"),
    ).toBe("/api/assets/photo-2/thumbnail?width=1280");
    expect(
      screen
        .getByRole("link", { name: "Download original photo" })
        .getAttribute("href"),
    ).toBe("/api/assets/photo-2");
    fireEvent.click(screen.getByRole("button", { name: "Show photo 3" }));
    expect(
      screen
        .getByRole("button", { name: "Next photo" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Show photo 3" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("supports scoped arrow keys, Home and End", () => {
    render(<SavedImageGallery images={images} title="Post" />);
    const gallery = screen.getByRole("region", { name: "Saved photos" });
    fireEvent.keyDown(gallery, { key: "End" });
    expect(screen.getByAltText("Post — photo 3 of 3")).toBeTruthy();
    fireEvent.keyDown(gallery, { key: "ArrowLeft" });
    expect(screen.getByAltText("Post — photo 2 of 3")).toBeTruthy();
    fireEvent.keyDown(gallery, { key: "Home" });
    expect(screen.getByAltText("Post — photo 1 of 3")).toBeTruthy();
  });

  it("swipes horizontally while leaving vertical scrolling alone", () => {
    render(<SavedImageGallery images={images} title="Post" />);
    const photo = screen.getByAltText("Post — photo 1 of 3");
    fireEvent.touchStart(photo, { touches: [{ clientX: 250, clientY: 100 }] });
    fireEvent.touchEnd(photo, {
      changedTouches: [{ clientX: 120, clientY: 108 }],
    });
    const second = screen.getByAltText("Post — photo 2 of 3");
    fireEvent.touchStart(second, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(second, {
      changedTouches: [{ clientX: 110, clientY: 50 }],
    });
    expect(screen.getByAltText("Post — photo 2 of 3")).toBeTruthy();
  });

  it("handles failed photos without loading an external embed", () => {
    const { container } = render(
      <SavedImageGallery images={images} title="Post" />,
    );
    fireEvent.error(screen.getByAltText("Post — photo 1 of 3"));
    expect(screen.getByText(/This photo could not be loaded/)).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Download original photo" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByAltText("Post — photo 2 of 3")).toBeTruthy();
  });

  it("keeps selection when attachments arrive and recovers if the selected file is removed", () => {
    const { rerender } = render(
      <SavedImageGallery images={images} title="Post" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show photo 2" }));
    rerender(
      <SavedImageGallery
        images={[
          { id: "new", assetType: "userUploaded", fileName: "first.jpg" },
          ...images,
        ]}
        title="Post"
      />,
    );
    expect(screen.getByAltText("Post — photo 3 of 4").getAttribute("src")).toBe(
      "/api/assets/photo-2/thumbnail?width=1280",
    );
    rerender(<SavedImageGallery images={[images[0]]} title="Post" />);
    expect(screen.getByAltText("Post — photo 1 of 1").getAttribute("src")).toBe(
      "/api/assets/photo-1/thumbnail?width=1280",
    );
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
    rerender(<SavedImageGallery images={[]} title="Post" />);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("enlarges the current photo and restores focus after closing", async () => {
    render(<SavedImageGallery images={images} title="Post" />);
    fireEvent.click(screen.getByRole("button", { name: "Show photo 2" }));
    const trigger = screen.getAllByRole("button", { name: "Enlarge photo" })[0];
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Post" })).toBeTruthy();
    expect(
      screen
        .getByRole("img", { name: "Post — photo 2 of 3" })
        .getAttribute("src"),
    ).toBe("/api/assets/photo-2");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

it("opens a local video with controls and navigates to the next photo", () => {
  const { container } = render(
    <SavedImageGallery
      title="Mixed post"
      images={[
        {
          id: "video",
          assetType: "userUploaded",
          fileName: "clip.mp4",
          video: { posterId: "poster" },
        },
        images[0],
      ]}
    />,
  );
  const video = screen.getByLabelText("Mixed post — item 1 of 2");
  expect(video.getAttribute("src")).toBe("/api/assets/video");
  expect(video.getAttribute("poster")).toBe(
    "/api/assets/poster/thumbnail?width=1280",
  );
  expect(video.hasAttribute("controls")).toBe(true);
  expect(video.hasAttribute("autoplay")).toBe(false);
  expect(video.closest("button")).toBeNull();
  fireEvent.keyDown(video, { key: "ArrowRight" });
  expect(container.querySelector("video")).toBe(video);
  fireEvent.click(screen.getByRole("button", { name: "Next item" }));
  expect(container.querySelector("video")).toBeNull();
  expect(video.getAttribute("src")).toBeNull();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  expect(
    screen.getByAltText("Mixed post — item 2 of 2").getAttribute("src"),
  ).toBe("/api/assets/photo-1/thumbnail?width=1280");
});

it("restores the video source under StrictMode and releases it on close", () => {
  const { unmount, container } = render(
    <React.StrictMode>
      <SavedImageGallery
        images={[
          {
            id: "strict-video",
            fileName: "clip.mp4",
            assetType: "video",
            video: { posterId: "poster" },
          },
        ]}
        title="Strict video"
      />
    </React.StrictMode>,
  );
  const video = container.querySelector("video")!;
  expect(video.getAttribute("src")).toBe("/api/assets/strict-video");
  unmount();
  expect(video.getAttribute("src")).toBeNull();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
});
