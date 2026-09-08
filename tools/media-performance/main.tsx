import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import BookmarkCardVideo from "@/components/dashboard/bookmarks/BookmarkCardVideo";
import VirtualMasonry from "@/components/dashboard/bookmarks/VirtualMasonry";
import SavedImageGallery from "@/components/dashboard/preview/SavedImageGallery";
import {
  getAssetThumbnailSrcSet,
  getAssetThumbnailUrl,
  getAssetHoverClipUrl,
} from "@karakeep/shared/utils/assetUtils";

function App() {
  const [selected, setSelected] = useState<number | null>(null);
  const [count, setCount] = useState(1000);
  const [columns, setColumns] = useState(4);
  const [narrow, setNarrow] = useState(false);
  const [editorHeight, setEditorHeight] = useState(160);
  useEffect(() => {
    const resize = () => setNarrow(innerWidth <= 640);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [focused, setFocused] = useState(-1);
  const ids = useMemo(
    () => ["editor", ...Array.from({ length: count }, (_, i) => String(i))],
    [count],
  );
  useEffect(() => {
    if (focused >= 0)
      document
        .querySelector(`[data-card="${focused}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  return (
    <>
      <header>
        Virtual media fixture
        <button onClick={() => setEditorHeight((h) => h + 220)}>
          Grow editor
        </button>
        <button onClick={() => setFocused(count - 1)}>Focus last card</button>
        <button onClick={() => setColumns((c) => (c === 4 ? 2 : 4))}>
          Change columns
        </button>
        <button onClick={() => setCount((c) => c + 1000)}>Append 1000</button>
        <button
          onClick={() => {
            setFocused(-1);
            setCount(20);
          }}
        >
          Filter to 20
        </button>
      </header>
      <main
        data-feed
        className="grid"
        style={{ height: "calc(100vh - 110px)", overflowY: "auto" }}
      >
        <VirtualMasonry
          ids={ids}
          columns={narrow ? 1 : columns}
          persistentIndex={0}
          focusedIndex={focused < 0 ? -1 : focused + 1}
          estimateHeight={280}
          renderItem={(id) =>
            id === "editor" ? (
              <div style={{ height: editorHeight, marginBottom: 16 }}>
                <input aria-label="Draft" placeholder="New bookmark draft" />
              </div>
            ) : (
              <a
                href="#"
                data-card={id}
                style={{
                  aspectRatio:
                    Number(id) % 3 === 0
                      ? "3/4"
                      : Number(id) % 3 === 1
                        ? "3/2"
                        : "1/1",
                  marginBottom: 16,
                }}
                onClick={(event) => {
                  event.preventDefault();
                  setSelected(Number(id));
                }}
              >
                <BookmarkCardVideo
                  src={getAssetHoverClipUrl(`video-${id}`)}
                  poster={getAssetThumbnailUrl(`poster-${id}`)}
                  posterSrcSet={getAssetThumbnailSrcSet(`poster-${id}`)}
                  alt={`Clip ${id}`}
                  naturalSize
                />
              </a>
            )
          }
        />
      </main>
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
