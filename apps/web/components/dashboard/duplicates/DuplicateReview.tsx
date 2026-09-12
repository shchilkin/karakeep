"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Copy, EyeOff, File, ScanSearch, ArrowLeft } from "lucide-react";
import { useTRPC } from "@karakeep/shared-react/trpc";
import type { AppRouter } from "@karakeep/trpc/routers/_app";
import {
  getAssetThumbnailUrl,
  getAssetUrl,
} from "@karakeep/shared/utils/assetUtils";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import { useSensitiveContent } from "../sensitive/SensitiveProvider";

type Group = inferRouterOutputs<AppRouter>["duplicates"]["get"];
function bytes(value: number) {
  const unit = value >= 1024 * 1024 ? "MiB" : value >= 1024 ? "KiB" : "B";
  const divisor = unit === "MiB" ? 1024 * 1024 : unit === "KiB" ? 1024 : 1;
  return (
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
      value / divisor,
    ) + ` ${unit}`
  );
}

export function DuplicateComparison({
  group,
  busy,
  onDecide,
}: {
  group: Group;
  busy: boolean;
  onDecide: (
    decision: "keep_both" | "defer" | "prefer_primary" | null,
    primaryBookmarkId?: string,
  ) => void;
}) {
  const { t } = useTranslation();
  const sensitive = useSensitiveContent();
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  useEffect(() => setExpandedAsset(null), [group.id]);
  return (
    <section className="space-y-6" aria-label={t("duplicates.compare")}>
      <div className="rounded-xl border bg-muted/30 p-4">
        <h2 className="font-medium">{t("duplicates.exact")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("duplicates.evidence_note")}
        </p>
        <p className="mt-2 text-sm">
          {t("duplicates.group_counts", {
            files: group.members.length,
            cards: new Set(group.members.map((m) => m.asset.bookmarkId)).size,
          })}{" "}
          · {bytes(group.size)}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("duplicates.partial_note")}
        </p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {group.cards.map((card) => {
          const hidden = sensitive.conceal(card);
          const matches = group.members.filter(
            (m) => m.asset.bookmarkId === card.id,
          );
          const context = group.cardContext.find(
            (c) => c.bookmarkId === card.id,
          );
          const source =
            card.content.type === "link"
              ? card.content.url
              : card.content.type === "asset" || card.content.type === "text"
                ? card.content.sourceUrl
                : null;
          return (
            <article
              key={card.id}
              className="min-w-0 overflow-hidden rounded-xl border"
            >
              <div className="space-y-3 bg-muted/20 p-3">
                {matches.map(({ asset, verifiedAt }) => (
                  <div key={asset.id} className="space-y-2">
                    <div className="flex min-h-48 items-center justify-center overflow-auto rounded-lg bg-muted">
                      {hidden ? (
                        <Button
                          variant="ghost"
                          onClick={() => sensitive.reveal(card)}
                        >
                          <EyeOff className="mr-2 size-4" />
                          {t("duplicates.reveal")}
                        </Button>
                      ) : asset.contentType?.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element -- Authenticated server thumbnails and explicit original-size mode need direct asset URLs.
                        <img
                          src={
                            expandedAsset === asset.id
                              ? getAssetUrl(asset.id)
                              : getAssetThumbnailUrl(asset.id, 640)
                          }
                          alt={
                            asset.fileName ??
                            card.title ??
                            t("duplicates.original")
                          }
                          loading="lazy"
                          className={
                            expandedAsset === asset.id
                              ? "max-h-[70vh] max-w-none"
                              : "max-h-80 w-full object-contain"
                          }
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-3 p-8">
                          <File className="size-10 text-muted-foreground" />
                          <span className="text-sm">{asset.contentType}</span>
                        </div>
                      )}
                    </div>
                    <p className="break-all text-sm font-medium">
                      {asset.fileName ?? t("duplicates.unnamed")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {asset.width && asset.height
                        ? `${asset.width} × ${asset.height} · `
                        : ""}
                      {bytes(asset.size)} · {asset.contentType} ·{" "}
                      {t("duplicates.verified_at", {
                        date: verifiedAt.toLocaleString(),
                      })}
                    </p>
                    {!hidden && (
                      <div className="flex flex-wrap gap-2">
                        {asset.contentType?.startsWith("image/") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setExpandedAsset(
                                expandedAsset === asset.id ? null : asset.id,
                              )
                            }
                          >
                            {expandedAsset === asset.id
                              ? t("duplicates.fit")
                              : t("duplicates.original_size")}
                          </Button>
                        )}
                        <a
                          href={getAssetUrl(asset.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="px-2 py-2 text-sm underline"
                        >
                          {t("duplicates.open_original")}
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="space-y-3 border-t p-4">
                <h3 className="break-words font-semibold">
                  {card.title ?? t("duplicates.unnamed")}
                </h3>
                {source && (
                  <a
                    href={source}
                    target="_blank"
                    rel="noreferrer"
                    className="block break-all text-sm text-muted-foreground underline"
                  >
                    {source}
                  </a>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <dt>{t("duplicates.first_saved")}</dt>
                  <dd>
                    {(card.firstCreatedAt ?? card.createdAt).toLocaleString()}
                  </dd>
                  <dt>{t("duplicates.last_saved")}</dt>
                  <dd>{card.createdAt.toLocaleString()}</dd>
                  <dt>{t("duplicates.attachments")}</dt>
                  <dd>{card.assets.length}</dd>
                  <dt>{t("duplicates.matching_originals")}</dt>
                  <dd>
                    {matches.length} /{" "}
                    {context?.originalCount ?? matches.length}
                  </dd>
                </dl>
                {!!context?.lists.length && (
                  <p className="text-xs text-muted-foreground">
                    {t("duplicates.lists")}:{" "}
                    {context.lists.map((l) => l.name).join(" · ")}
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  {card.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded-md bg-muted px-2 py-1 text-xs"
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
                {card.note && (
                  <div className="rounded-lg border p-3">
                    <h4 className="mb-1 text-xs text-muted-foreground">
                      {t("duplicates.note")}
                    </h4>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {card.note}
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant={
                      group.decision?.primaryBookmarkId === card.id
                        ? "default"
                        : "outline"
                    }
                    disabled={busy}
                    onClick={() => onDecide("prefer_primary", card.id)}
                  >
                    {t("duplicates.prefer_primary")}
                  </Button>
                  <Link
                    href={`/dashboard/preview/${card.id}`}
                    className="text-sm underline"
                  >
                    {t("duplicates.open_card")}
                  </Link>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {group.truncated && <p role="status">{t("duplicates.truncated")}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button disabled={busy} onClick={() => onDecide("keep_both")}>
          {t("duplicates.keep_both")}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onDecide("defer")}
        >
          {t("duplicates.defer")}
        </Button>
        {group.decision && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onDecide(null)}
          >
            {t("duplicates.undo")}
          </Button>
        )}
      </div>
      {group.decision && (
        <p role="status" className="text-sm">
          {t(`duplicates.decision_${group.decision.decision}`)}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {t("duplicates.retained")}
      </p>
    </section>
  );
}

function GroupDetails({ id }: { id: string }) {
  const api = useTRPC();
  const cache = useQueryClient();
  const { t } = useTranslation();
  const detail = useQuery(api.duplicates.get.queryOptions({ groupId: id }));
  const decide = useMutation(
    api.duplicates.decide.mutationOptions({
      onSuccess: () =>
        cache.invalidateQueries({ queryKey: api.duplicates.pathKey() }),
    }),
  );
  if (detail.isPending) return <p role="status">{t("duplicates.loading")}</p>;
  if (detail.isError) return <p role="alert">{detail.error.message}</p>;
  const group = detail.data;
  return (
    <>
      {decide.isError && (
        <p role="alert" className="mb-4 text-destructive">
          {decide.error.message}{" "}
          <Button
            variant="ghost"
            onClick={() => {
              decide.reset();
              void detail.refetch();
            }}
          >
            {t("duplicates.refresh")}
          </Button>
        </p>
      )}
      <DuplicateComparison
        group={group}
        busy={decide.isPending}
        onDecide={(decision, primaryBookmarkId) =>
          decide.mutate({
            groupId: id,
            evidenceVersion: group.evidenceVersion,
            expectedDecisionVersion: group.decisionVersion,
            decision,
            primaryBookmarkId: primaryBookmarkId ?? null,
          })
        }
      />
    </>
  );
}

export default function DuplicateReview() {
  const api = useTRPC();
  const cache = useQueryClient();
  const { t } = useTranslation();
  const [view, setView] = useState<"pending" | "reviewed" | "all">("pending");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const continuing = useRef(false);
  useEffect(
    () => () => {
      continuing.current = false;
    },
    [],
  );
  const status = useQuery(api.duplicates.status.queryOptions());
  const list = useQuery(
    api.duplicates.list.queryOptions({ view, cursor, limit: 20 }),
  );
  const scan = useMutation(api.duplicates.scanNext.mutationOptions());
  const start = async (recheck: boolean) => {
    if (continuing.current) return;
    continuing.current = true;
    setScanning(true);
    setProcessed(0);
    setScanError(null);
    let afterId: string | null = null;
    try {
      while (continuing.current) {
        const result = await scan.mutateAsync({ afterId, recheck });
        if (result.done) break;
        afterId = result.nextCursor;
        setProcessed((n) => n + 1);
        await cache.invalidateQueries({
          queryKey: api.duplicates.status.pathKey(),
        });
      }
    } catch (error) {
      setScanError(
        error instanceof Error ? error.message : t("duplicates.scan_error"),
      );
    } finally {
      continuing.current = false;
      setScanning(false);
      await cache.invalidateQueries({ queryKey: api.duplicates.pathKey() });
    }
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl">
          <Copy className="size-6" />
          {t("duplicates.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("duplicates.intro")}</p>
      </header>
      {status.data && (
        <section
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4"
          aria-label={t("duplicates.index")}
        >
          <div>
            <p className="font-medium">
              {t("duplicates.coverage", {
                verified: status.data.verified,
                total: status.data.originals,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("duplicates.pending_count", {
                pending: status.data.needsIndex,
                errors: status.data.errors,
              })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {scanning ? (
              <Button
                variant="outline"
                onClick={() => {
                  continuing.current = false;
                }}
              >
                {t("duplicates.stop")}
              </Button>
            ) : (
              <>
                <Button onClick={() => void start(false)}>
                  <ScanSearch className="mr-2 size-4" />
                  {t("duplicates.scan_new")}
                </Button>
                <Button variant="outline" onClick={() => void start(true)}>
                  {t("duplicates.recheck")}
                </Button>
              </>
            )}
          </div>
          <p className="basis-full text-xs text-muted-foreground">
            {t("duplicates.scan_limits", {
              size: bytes(status.data.maxFileBytes),
            })}
          </p>
        </section>
      )}
      {scanning && (
        <p role="status" aria-live="polite">
          {t("duplicates.scanning", { count: processed })}
        </p>
      )}
      {scanError && (
        <p role="alert" className="text-destructive">
          {scanError}
        </p>
      )}
      {status.isError && <p role="alert">{status.error.message}</p>}
      {selected ? (
        <>
          <Button variant="ghost" onClick={() => setSelected(null)}>
            <ArrowLeft className="mr-2 size-4" />
            {t("duplicates.back")}
          </Button>
          <GroupDetails key={selected} id={selected} />
        </>
      ) : (
        <>
          <div
            className="flex flex-wrap gap-2"
            aria-label={t("duplicates.filters")}
          >
            {(["pending", "reviewed", "all"] as const).map((value) => (
              <Button
                key={value}
                variant={view === value ? "secondary" : "ghost"}
                aria-pressed={view === value}
                onClick={() => {
                  setView(value);
                  setCursor(null);
                }}
              >
                {t(`duplicates.view_${value}`)}
              </Button>
            ))}
          </div>
          {list.isPending ? (
            <p role="status">{t("duplicates.loading")}</p>
          ) : list.isError ? (
            <p role="alert">{list.error.message}</p>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                {list.data.groups.map((group) => (
                  <button
                    key={group.id}
                    onClick={() => setSelected(group.id)}
                    className="rounded-xl border p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="font-medium">
                      {t("duplicates.group_counts", {
                        files: group.files,
                        cards: group.cards,
                      })}
                    </span>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("duplicates.exact")} · {bytes(group.size)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("duplicates.copy_bytes", {
                        size: bytes(group.copyBytes),
                      })}
                    </p>
                    {group.decision && (
                      <p className="mt-3 text-xs">
                        {t(`duplicates.decision_${group.decision}`)}
                      </p>
                    )}
                  </button>
                ))}
              </div>
              {list.data.groups.length === 0 && (
                <p className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
                  {t("duplicates.empty_page")}
                </p>
              )}
              <div className="flex gap-2">
                {cursor && (
                  <Button variant="outline" onClick={() => setCursor(null)}>
                    {t("duplicates.first_page")}
                  </Button>
                )}
                {list.data.nextCursor && (
                  <Button
                    variant="outline"
                    onClick={() => setCursor(list.data.nextCursor)}
                  >
                    {t("duplicates.next_page")}
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
