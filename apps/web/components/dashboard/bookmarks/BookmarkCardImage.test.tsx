// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
  const { container } = render(
    <BookmarkCardImage src="/cached.webp" alt="Cached photo" naturalSize />,
  );
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(
    screen.getByAltText("Cached photo").classList.contains("opacity-100"),
  ).toBe(true);
});
