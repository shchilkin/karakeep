"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  EyeOff,
  Images,
  Plus,
  X,
} from "lucide-react";
import { useTRPC } from "@karakeep/shared-react/trpc";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { getAssetThumbnailUrl } from "@karakeep/shared/utils/assetUtils";
import { getBookmarkTitle } from "@karakeep/shared/utils/bookmarkUtils";
import { useTranslation } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSensitiveContent } from "../sensitive/SensitiveProvider";

type Member = NonNullable<ZBookmark["imageSet"]>["members"][number] & {
  concealed?: boolean;
};
export function imageSetCandidate(bookmark: ZBookmark): Member | null {
  if (
    bookmark.imageSet ||
    bookmark.memberOfSet ||
    bookmark.content.type !== "asset" ||
    bookmark.content.assetType !== "image"
  )
    return null;
  const assetId = bookmark.content.assetId;
  const image = bookmark.assets.find((a) => a.id === assetId);
  if (!image) return null;
  return {
    bookmarkId: bookmark.id,
    title: getBookmarkTitle(bookmark) ?? "Untitled",
    sourceUrl: bookmark.content.sourceUrl ?? null,
    image,
  };
}
function MemberThumbnail({ member }: { member: Member }) {
  return member.concealed ? (
    <span className="flex size-16 shrink-0 items-center justify-center rounded-md bg-muted">
      <EyeOff className="size-5" />
    </span>
  ) : (
    <Image
      width={64}
      height={64}
      unoptimized
      alt=""
      src={getAssetThumbnailUrl(member.image.id, 320)}
      className="size-16 shrink-0 rounded-md object-cover"
      loading="lazy"
    />
  );
}

/** Mount afresh on each open: discard only an unsaved draft on close. */
export default function ImageSetEditor({
  bookmark,
  selected = [],
  onClose,
  onSaved,
}: {
  bookmark?: ZBookmark;
  selected?: ZBookmark[];
  onClose: () => void;
  onSaved?: (card: ZBookmark) => void;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const router = useRouter();
  const { conceal } = useSensitiveContent();
  const [id] = useState(() => bookmark?.id ?? crypto.randomUUID());
  const [title, setTitle] = useState(bookmark?.title ?? "");
  const [members, setMembers] = useState<Member[]>(
    () =>
      bookmark?.imageSet?.members.map((m) => ({
        ...m,
        concealed: conceal(bookmark),
      })) ??
      selected.flatMap((b) => {
        const m = imageSetCandidate(b);
        return m ? [{ ...m, concealed: conceal(b) }] : [];
      }),
  );
  const [cover, setCover] = useState(
    bookmark?.imageSet?.coverBookmarkId ?? members[0]?.bookmarkId,
  );
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const candidates = useQuery(
    api.imageSets.candidates.queryOptions(
      { query, offset },
      { enabled: picking },
    ),
  );
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: api.bookmarks.pathKey() });
    await cache.invalidateQueries({ queryKey: api.imageSets.pathKey() });
    await cache.invalidateQueries({ queryKey: api.ai.pathKey() });
  };
  const save = useMutation(
    api.imageSets.save.mutationOptions({
      onSuccess: async (card) => {
        await refresh();
        onSaved?.(card);
        onClose();
        router.push(`/dashboard/preview/${card.id}`);
      },
    }),
  );
  const dissolve = useMutation(
    api.imageSets.dissolve.mutationOptions({
      onSuccess: async () => {
        await refresh();
        onClose();
        router.push("/dashboard/bookmarks");
      },
    }),
  );
  const busy = save.isPending || dissolve.isPending;
  const move = (index: number, direction: number) =>
    setMembers((previous) => {
      const next = [...previous];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
  const error = save.error ?? dissolve.error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(bookmark ? "image_sets.edit" : "image_sets.create")}
          </DialogTitle>
          <DialogDescription>{t("image_sets.description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          <label className="block space-y-2 text-sm">
            <span>{t("image_sets.title")}</span>
            <Input
              value={title}
              maxLength={180}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              autoFocus
              placeholder={t("image_sets.title_placeholder")}
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm tabular-nums">
              <Images className="size-4" />
              {t("image_sets.count", { count: members.length })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || members.length >= 50}
              onClick={() => setPicking(!picking)}
            >
              <Plus className="mr-2 size-4" />
              {t("image_sets.add")}
            </Button>
          </div>
          {picking && (
            <section className="space-y-3" aria-label={t("image_sets.add")}>
              <Input
                aria-label={t("image_sets.search")}
                placeholder={t("image_sets.search")}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOffset(0);
                }}
              />
              {candidates.isLoading && (
                <p role="status" className="text-sm">
                  {t("ai_control.loading")}
                </p>
              )}
              {candidates.error && (
                <p role="alert" className="text-sm">
                  {candidates.error.message}
                </p>
              )}
              {candidates.data?.cards.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("image_sets.empty")}
                </p>
              )}
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {candidates.data?.cards.map((b) => {
                  const m = imageSetCandidate(b);
                  if (!m) return null;
                  const added = members.some(
                    (item) => item.bookmarkId === b.id,
                  );
                  return (
                    <li key={b.id}>
                      <button
                        className="flex w-full items-center gap-3 rounded-md p-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        disabled={busy || added || members.length >= 50}
                        onClick={() => {
                          setMembers([
                            ...members,
                            { ...m, concealed: conceal(b) },
                          ]);
                          if (!cover) setCover(b.id);
                        }}
                      >
                        <MemberThumbnail
                          member={{ ...m, concealed: conceal(b) }}
                        />
                        <span className="line-clamp-2 min-w-0 flex-1 break-words">
                          {m.title}
                        </span>
                        {added ? (
                          <Check className="size-4 shrink-0" />
                        ) : (
                          <Plus className="size-4 shrink-0" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 24))}
                >
                  {t("image_sets.previous")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={candidates.data?.nextOffset == null}
                  onClick={() => setOffset(candidates.data!.nextOffset!)}
                >
                  {t("image_sets.next")}
                </Button>
              </div>
            </section>
          )}
          <ol className="space-y-2" aria-label={t("image_sets.order")}>
            {members.map((member, index) => (
              <li
                key={member.bookmarkId}
                className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/40 p-3 sm:flex-nowrap"
              >
                <MemberThumbnail member={member} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/dashboard/preview/${member.bookmarkId}`}
                    target="_blank"
                    className="line-clamp-2 break-words text-sm underline-offset-4 hover:underline"
                  >
                    {member.title}
                  </Link>
                  <button
                    className="mt-1 flex items-center gap-1 rounded text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={busy}
                    onClick={() => setCover(member.bookmarkId)}
                  >
                    {cover === member.bookmarkId && (
                      <Check className="size-3.5" />
                    )}
                    {t(
                      cover === member.bookmarkId
                        ? "image_sets.cover"
                        : "image_sets.make_cover",
                    )}
                  </button>
                </div>
                <div className="ml-auto flex shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("image_sets.move_up", {
                      position: index + 1,
                    })}
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("image_sets.move_down", {
                      position: index + 1,
                    })}
                    disabled={busy || index === members.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("image_sets.remove", { position: index + 1 })}
                    disabled={busy}
                    onClick={() => {
                      const next = members.filter(
                        (m) => m.bookmarkId !== member.bookmarkId,
                      );
                      setMembers(next);
                      if (member.bookmarkId === cover)
                        setCover(next[0]?.bookmarkId);
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("image_sets.ai_hold")}
          </p>
          {confirmDissolve && (
            <div className="space-y-3">
              <p className="text-sm">{t("image_sets.dissolve_description")}</p>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  dissolve.mutate({
                    id,
                    revision: bookmark!.imageSet!.revision,
                  })
                }
              >
                {t("image_sets.confirm_dissolve")}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error.message}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          {bookmark && (
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={busy}
              onClick={() => setConfirmDissolve(!confirmDissolve)}
            >
              {t("image_sets.dissolve")}
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button
            disabled={
              busy ||
              !title.trim() ||
              members.length < 2 ||
              members.length > 50 ||
              !cover
            }
            onClick={() =>
              save.mutate({
                id,
                revision: bookmark?.imageSet?.revision,
                composition: {
                  title: title.trim(),
                  memberIds: members.map((m) => m.bookmarkId),
                  coverBookmarkId: cover!,
                },
              })
            }
          >
            {busy ? t("ai_control.loading") : t("image_sets.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
