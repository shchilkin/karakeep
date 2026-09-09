import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import BookmarkCardImage from "@/components/dashboard/bookmarks/BookmarkCardImage";
import BookmarkCardVideo from "@/components/dashboard/bookmarks/BookmarkCardVideo";
import VirtualMasonry from "@/components/dashboard/bookmarks/VirtualMasonry";

const withDimensions = new URLSearchParams(location.search).has("dimensions");
const dynamic = new URLSearchParams(location.search).has("dynamic");
const dimensions = (id: string) =>
  withDimensions
    ? {
        width: 640,
        height: Number(id) % 3 === 0 ? 960 : Number(id) % 3 === 1 ? 400 : 640,
      }
    : undefined;

const ids = Array.from({ length: 18 }, (_, i) => String(i));
const estimateHeight = (id: string, width: number) => {
  const size = dimensions(id);
  return size ? (width * size.height) / size.width + 56 : 340;
};
function App() {
  const [items, setItems] = useState(ids);
  const nextId = useRef(1000);
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
        {dynamic && (
          <>
            <button
              onClick={() => {
                const id = String(nextId.current++);
                setItems([id, ...items]);
              }}
            >
              Prepend card
            </button>
            <button
              onClick={() => {
                const id = String(nextId.current++);
                setItems([...items, id]);
              }}
            >
              Append card
            </button>
            <button onClick={() => setItems(items.slice(1))}>
              Remove newest
            </button>
            <button onClick={() => setItems([...items].reverse())}>
              Reverse sort
            </button>
          </>
        )}
      </header>
      <div
        data-feed
        style={{
          height: mobile ? undefined : 650,
          overflowY: mobile ? "visible" : "auto",
        }}
      >
        <VirtualMasonry
          ids={items}
          columns={mobile ? 1 : columns}
          estimateHeight={estimateHeight}
          renderItem={(id) => (
            <div data-card={id} className="mb-6">
              {Number(id) % 2 === 0 ? (
                <BookmarkCardImage
                  src={`/media/${id}.svg`}
                  alt={`Photo ${id}`}
                  dimensions={dimensions(id)}
                  naturalSize
                />
              ) : (
                <BookmarkCardVideo
                  src={`/media/${id}.mp4`}
                  poster={`/media/${id}.svg`}
                  alt={`Video ${id}`}
                  dimensions={dimensions(id)}
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
