import { Button } from "@/components/ui/button";
import { useClientConfig } from "@/lib/clientConfig";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { catalogBusy, catalogInput } from "@karakeep/shared/mediaCatalog";
import { localCheckCategoryKeys } from "@karakeep/shared/mediaLocalCheck";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";

export default function MediaCatalogArea({
  bookmark,
  readOnly,
  includeManualSummary = true,
}: {
  bookmark: ZBookmark;
  readOnly: boolean;
  includeManualSummary?: boolean;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const config = useClientConfig();
  const generate = useMutation(
    api.bookmarks.analyzeMedia.mutationOptions({
      onSuccess: async () => {
        await cache.invalidateQueries({ queryKey: api.bookmarks.pathKey() });
      },
    }),
  );
  const state = bookmark.mediaAi;
  const busy = catalogBusy(state) || generate.isPending;
  const input = catalogInput(bookmark, true);
  const interrupted =
    !!state &&
    ["pending", "processing", "checking_local", "processing_local"].includes(
      state.status,
    ) &&
    !catalogBusy(state);
  const summary =
    (includeManualSummary ? bookmark.summary : null) ?? state?.result?.summary;
  const canGenerate =
    config.mediaAi?.enabled &&
    !readOnly &&
    !!input &&
    state?.status !== "success";
  const failureMessages = {
    local_review: t("media_ai.local_review"),
    local_only: t("media_ai.local_only"),
    local_failed: t("media_ai.local_failed"),
    refused: t("media_ai.refused"),
    quota_exceeded: t("media_ai.quota"),
    timeout: t("media_ai.timeout"),
    rate_limited: t("media_ai.rate_limited"),
    stale: t("media_ai.stale"),
    failed: t("media_ai.failed"),
    cancelled: t("media_ai.cancelled"),
  };
  const statusMessage = generate.isError
    ? failureMessages.failed
    : interrupted
      ? t("media_ai.interrupted")
      : busy
        ? t(
            state?.status === "waiting_resource"
              ? "media_ai.waiting_resource"
              : state?.status === "checking_local"
                ? "media_ai.checking_local"
                : state?.status === "processing_local"
                  ? "media_ai.processing_local"
                  : "media_ai.processing",
          )
        : state && state.status in failureMessages
          ? failureMessages[state.status as keyof typeof failureMessages]
          : null;
  if (!state && !summary && !canGenerate) return null;
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-4"
      aria-label={t("media_ai.details")}
    >
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden="true" />
        {t("media_ai.details")}
      </div>
      {summary && (
        <p className="whitespace-pre-line break-words text-sm leading-relaxed">
          {summary}
        </p>
      )}
      {state?.resultSource && state.result && !bookmark.summary && (
        <p className="text-xs text-muted-foreground">
          {state.resultSource.provider === "local"
            ? t("media_ai.source_local")
            : t("media_ai.source_cloud")}{" "}
          · {state.resultSource.model}
        </p>
      )}
      {state?.localCheckUnavailable &&
        !state.localCheck?.frames.some(
          (frame) => frame.status === "unknown",
        ) && (
          <p className="text-xs text-muted-foreground">
            {t("media_ai.local_unknown")}
          </p>
        )}
      {state?.localCheck && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {t("media_ai.local_scope", {
              count: state.localCheck.frames.length,
            })}
          </p>
          <p>
            {localCheckCategoryKeys(state.localCheck)
              .map((key) => t(key))
              .join(", ")}
          </p>
          {state.localCheck.frames.some(
            (frame) => frame.status === "unknown",
          ) && <p>{t("media_ai.local_unknown")}</p>}
        </div>
      )}
      <div
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        {statusMessage}
      </div>
      {canGenerate && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            generate.mutate({
              bookmarkId: bookmark.id,
              retry: !!state,
              allowPreview: input?.media.coverage === "preview_only",
              localOnly: state?.localOnly,
            })
          }
        >
          {state
            ? t("media_ai.retry")
            : input?.media.coverage === "preview_only"
              ? t("media_ai.analyze_preview")
              : t("media_ai.analyze")}
        </Button>
      )}
    </section>
  );
}
