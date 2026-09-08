import { expect, it, vi } from "vitest";
import { createMediaPlaybackCoordinator } from "./mediaPlayback";

it("allows one preview, revokes it for a viewer and ignores stale cleanup", () => {
  const manager = createMediaPlaybackCoordinator();
  const first = {},
    second = {};
  const revokeFirst = vi.fn(),
    revokeSecond = vi.fn();
  expect(manager.requestPreview(first, revokeFirst)).toBe(true);
  expect(manager.requestPreview(second, revokeSecond)).toBe(true);
  expect(revokeFirst).toHaveBeenCalledOnce();
  manager.releasePreview(first);
  const close = manager.openViewer();
  expect(revokeSecond).toHaveBeenCalledOnce();
  expect(manager.requestPreview(first, revokeFirst)).toBe(false);
  close();
  expect(manager.requestPreview(first, revokeFirst)).toBe(true);
});
it("keeps previews blocked until all overlapping viewer lifecycles close", () => {
  const manager = createMediaPlaybackCoordinator();
  const closeFirst = manager.openViewer(),
    closeSecond = manager.openViewer();
  closeFirst();
  closeFirst();
  expect(manager.requestPreview({}, vi.fn())).toBe(false);
  closeSecond();
  expect(manager.requestPreview({}, vi.fn())).toBe(true);
});
