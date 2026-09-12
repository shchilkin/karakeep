"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import { useTRPC } from "@karakeep/shared-react/trpc";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { importStageOrder } from "@karakeep/shared/types/importProcessing";
import type { ImportProcessingStage } from "@karakeep/shared/types/importProcessing";

export default function ImportProcessingArea({
  bookmark,
  readOnly,
}: {
  bookmark: ZBookmark;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const initial = bookmark.importProcessing;
  const query = useQuery(
    api.deferredImport.processing.queryOptions(
      { id: initial?.sourceRevisionId ?? "" },
      {
        enabled: !!initial && !readOnly,
        refetchInterval: (q) =>
          ["queued", "running", "waiting_ai"].includes(
            q.state.data?.state ?? "",
          )
            ? 1500
            : false,
      },
    ),
  );
  const state = query.data ?? initial;
  const release = useMutation(
    api.deferredImport.release.mutationOptions({
      onSettled: async () => {
        await cache.invalidateQueries({
          queryKey: api.deferredImport.pathKey(),
        });
        await cache.invalidateQueries({ queryKey: api.bookmarks.pathKey() });
      },
    }),
  );
  useEffect(() => {
    if (state)
      void cache.invalidateQueries({ queryKey: api.bookmarks.pathKey() });
  }, [state?.state, state?.generation, state?.previewReady, cache, api]);
  if (!state || readOnly) return null;
  const stages: ImportProcessingStage[] = [
    "preview",
    "search",
    "local_check",
    "catalog",
  ];
  const next =
    state.state === "held" || state.state === "failed"
      ? state.stage
      : stages[importStageOrder[state.stage]];
  const busy =
    ["queued", "running", "waiting_ai"].includes(state.state) ||
    release.isPending;
  return (
    <section
      className="space-y-3 rounded-xl border border-border/60 p-4"
      aria-label={t("import_processing.title")}
    >
      <p className="text-sm font-medium">{t("import_processing.title")}</p>
      <p className="text-xs text-muted-foreground">
        {t("import_processing.preserved")}
      </p>
      <p className="text-sm" role="status" aria-live="polite">
        {t(`import_processing.states.${state.state}`)} ·{" "}
        {t(`import_processing.stages.${state.stage}`)}
      </p>
      {release.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("import_processing.request_failed")}
        </p>
      )}
      {(next || state.state === "failed") && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            release.mutate({
              id: state.sourceRevisionId,
              requestId: crypto.randomUUID(),
              stage: next ?? state.stage,
              expectedGeneration: state.generation,
              retry: state.state === "failed",
            })
          }
        >
          {state.state === "failed"
            ? t("import_processing.retry")
            : t(`import_processing.actions.${next}`)}
        </Button>
      )}
    </section>
  );
}
