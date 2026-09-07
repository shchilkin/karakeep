import { Button } from "@/components/ui/button";
import { useClientConfig } from "@/lib/clientConfig";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { catalogBusy, catalogInput } from "@karakeep/shared/mediaCatalog";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";

export default function MediaCatalogArea({
  bookmark,
  readOnly,
}: {
  bookmark: ZBookmark;
  readOnly: boolean;
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
    ["pending", "processing"].includes(state.status) &&
    !catalogBusy(state);
  const summary = bookmark.summary ?? state?.result?.summary;
  const canGenerate =
    config.mediaAi?.enabled &&
    !readOnly &&
    !!input &&
    state?.status !== "success";
  const failureMessages = {
    refused: t("media_ai.refused"),
    quota_exceeded: t("media_ai.quota"),
    timeout: t("media_ai.timeout"),
    rate_limited: t("media_ai.rate_limited"),
    stale: t("media_ai.stale"),
    failed: t("media_ai.failed"),
  };
  const statusMessage = generate.isError
    ? failureMessages.failed
    : interrupted
      ? t("media_ai.interrupted")
      : busy
        ? t("media_ai.processing")
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
