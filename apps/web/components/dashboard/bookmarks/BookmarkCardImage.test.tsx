// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CardImageDimensionsSlot } from "@/lib/cardImageDimensions";
import { CardImageDimensionsContext } from "@/lib/cardImageDimensions";
import BookmarkCardImage from "./BookmarkCardImage";

vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("reserves a placeholder until loaded, resets on replacement and handles failure", () => {
  const { container, rerender } = render(
    <BookmarkCardImage
      key="one"
      src="/one.webp"
      alt="Saved photo"
      naturalSize
    />,
  );
  expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  fireEvent.load(screen.getByAltText("Saved photo"));
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(
    screen.getByAltText("Saved photo").classList.contains("opacity-100"),
  ).toBe(true);
  rerender(
    <BookmarkCardImage
      key="two"
      src="/two.webp"
      alt="Saved photo"
      naturalSize
    />,
  );
  expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  fireEvent.error(screen.getByAltText("Saved photo"));
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(screen.getByText("preview.gallery.load_error")).toBeTruthy();
});

it("reveals an already cached image without waiting for another load event", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    640,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    960,
  );
  const dimensions: CardImageDimensionsSlot = {};
  const { container } = render(
    <CardImageDimensionsContext value={dimensions}>
      <BookmarkCardImage src="/cached.webp" alt="Cached photo" naturalSize />
    </CardImageDimensionsContext>,
  );
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(
    screen.getByAltText("Cached photo").classList.contains("opacity-100"),
  ).toBe(true);
  expect(dimensions.current).toEqual({
    src: "/cached.webp",
    width: 640,
    height: 960,
  });
});

it("keeps a revisited image's proportions while loading or failing, and forgets a replaced source", () => {
  const dimensions: CardImageDimensionsSlot = {};
  const tree = (src: string | null) => (
    <CardImageDimensionsContext value={dimensions}>
      {src && (
        <BookmarkCardImage key={src} src={src} alt="Portrait" naturalSize />
      )}
    </CardImageDimensionsContext>
  );
  const { container, rerender } = render(tree("/portrait.webp"));
  const first = screen.getByAltText("Portrait");
  Object.defineProperties(first, {
    naturalWidth: { value: 640 },
    naturalHeight: { value: 960 },
  });
  fireEvent.load(first);
  const frame = () => container.querySelector<HTMLElement>("[aria-busy]")!;
  expect(frame().style.aspectRatio).toBe("640 / 960");
  rerender(tree(null));
  rerender(tree("/portrait.webp"));
  expect(frame().getAttribute("aria-busy")).toBe("true");
  expect(frame().style.aspectRatio).toBe("640 / 960");
  fireEvent.error(screen.getByAltText("Portrait"));
  expect(frame().style.aspectRatio).toBe("640 / 960");
  expect(screen.getByText("preview.gallery.load_error")).toBeTruthy();
  rerender(tree("/replacement.webp"));
  expect(frame().style.aspectRatio).toBe("4 / 3");
  expect(frame().getAttribute("aria-busy")).toBe("true");
});

it("reserves server dimensions on first render and keeps them across thumbnail rounding and errors", () => {
  const { container, rerender } = render(
    <BookmarkCardImage
      src="/first.webp"
      alt="First visit"
      naturalSize
      dimensions={{ width: 1001, height: 1500 }}
    />,
  );
  const frame = () => container.querySelector<HTMLElement>("[aria-busy]")!;
  expect(frame().style.aspectRatio).toBe("1001 / 1500");
  expect(frame().getAttribute("aria-busy")).toBe("true");
  const img = screen.getByAltText("First visit");
  Object.defineProperties(img, {
    naturalWidth: { value: 320 },
    naturalHeight: { value: 480 },
  });
  fireEvent.load(img);
  expect(frame().style.aspectRatio).toBe("1001 / 1500");
  fireEvent.error(img);
  expect(frame().style.aspectRatio).toBe("1001 / 1500");
  rerender(
    <BookmarkCardImage
      key="new"
      src="/new.webp"
      alt="New"
      naturalSize
      dimensions={{ width: 0, height: 900 }}
    />,
  );
  expect(frame().style.aspectRatio).toBe("4 / 3");
});
