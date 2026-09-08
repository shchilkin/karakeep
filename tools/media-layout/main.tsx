import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import BookmarkCardImage from "@/components/dashboard/bookmarks/BookmarkCardImage";
import BookmarkCardVideo from "@/components/dashboard/bookmarks/BookmarkCardVideo";
import VirtualMasonry from "@/components/dashboard/bookmarks/VirtualMasonry";

const ids = Array.from({ length: 18 }, (_, i) => String(i));
function App() {
  const [columns, setColumns] = useState(3);
  const [mobile, setMobile] = useState(innerWidth < 640);
  useEffect(() => {
    const resize = () => setMobile(innerWidth < 640);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return (
    <main className="min-h-screen bg-muted p-6 text-foreground">
      <header className="mb-4 flex justify-between">
        <h1>Media layout stability</h1>
        <button onClick={() => setColumns(columns === 3 ? 2 : 3)}>
          Change columns
        </button>
      </header>
      <div
        data-feed
        style={{
          height: mobile ? undefined : 650,
          overflowY: mobile ? "visible" : "auto",
        }}
      >
        <VirtualMasonry
          ids={ids}
          columns={mobile ? 1 : columns}
          estimateHeight={340}
          renderItem={(id) => (
            <div data-card={id} className="mb-6">
              {Number(id) % 2 === 0 ? (
                <BookmarkCardImage
                  src={`/media/${id}.svg`}
                  alt={`Photo ${id}`}
                  naturalSize
                />
              ) : (
                <BookmarkCardVideo
                  src={`/media/${id}.mp4`}
                  poster={`/media/${id}.svg`}
                  alt={`Video ${id}`}
                  naturalSize
                />
              )}
              <p className="pt-3 text-center text-sm">Card {id}</p>
            </div>
          )}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
