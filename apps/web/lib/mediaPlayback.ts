/** A gallery takes priority over the single hover preview in this browser tab. */
export function createMediaPlaybackCoordinator() {
  let preview: { owner: object; revoke: () => void } | undefined;
  const viewers = new Set<object>();
  const stopPreview = () => {
    const previous = preview;
    preview = undefined;
    previous?.revoke();
  };
  return {
    requestPreview(owner: object, revoke: () => void) {
      if (viewers.size) return false;
      if (preview?.owner !== owner) stopPreview();
      preview = { owner, revoke };
      return true;
    },
    releasePreview(owner: object) {
      if (preview?.owner === owner) preview = undefined;
    },
    openViewer() {
      const owner = {};
      viewers.add(owner);
      stopPreview();
      return () => {
        viewers.delete(owner);
      };
    },
  };
}

export const mediaPlayback = createMediaPlaybackCoordinator();

export function releaseVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}
