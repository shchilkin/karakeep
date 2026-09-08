import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import BookmarkCardVideo from "@/components/dashboard/bookmarks/BookmarkCardVideo";
import SavedImageGallery from "@/components/dashboard/preview/SavedImageGallery";
import {
  getAssetThumbnailSrcSet,
  getAssetThumbnailUrl,
  getAssetUrl,
} from "@karakeep/shared/utils/assetUtils";

function App() {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <>
      <header>
        1000 archived video cards — real card and gallery components
      </header>
      <div className="grid">
        {Array.from({ length: 1000 }, (_, i) => (
          <a
            key={i}
            href="#"
            data-card={i}
            onClick={(event) => {
              event.preventDefault();
              setSelected(i);
            }}
          >
            <BookmarkCardVideo
              src={getAssetUrl(`video-${i}`)}
              poster={getAssetThumbnailUrl(`poster-${i}`)}
              posterSrcSet={getAssetThumbnailSrcSet(`poster-${i}`)}
              alt={`Clip ${i}`}
              naturalSize
            />
          </a>
        ))}
      </div>
      {selected !== null && (
        <div className="viewer" data-viewer>
          <button onClick={() => setSelected(null)}>
            Close fixture viewer
          </button>
          <SavedImageGallery
            title="Test gallery"
            images={[
              {
                id: `video-${selected}`,
                assetType: "video",
                fileName: "one.mp4",
                video: { posterId: `poster-${selected}` },
              },
              {
                id: `photo-${selected}`,
                assetType: "userUploaded",
                fileName: "two.jpg",
              },
              {
                id: `video-next-${selected}`,
                assetType: "video",
                fileName: "three.mp4",
                video: { posterId: `poster-next-${selected}` },
              },
            ]}
          />
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
