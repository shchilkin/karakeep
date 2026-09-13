"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";
import type { AiBatchRequest } from "@karakeep/shared/aiControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n/client";

export default function AiQueueDialog({
  open,
  onOpenChange,
  selection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: AiBatchRequest["selection"];
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const config = useQuery(
    api.ai.configuration.queryOptions(undefined, { enabled: open }),
  );
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"hybrid" | "local">("hybrid");
  const [refresh, setRefresh] = useState(false);
  const requestId = useRef<string | null>(null);
  const prepare = useMutation(api.ai.prepare.mutationOptions());
  const start = useMutation(
    api.ai.changeBatch.mutationOptions({
      onSuccess: async () => {
        await cache.invalidateQueries({ queryKey: api.ai.pathKey() });
        await cache.invalidateQueries({ queryKey: api.bookmarks.pathKey() });
      },
    }),
  );
  useEffect(() => {
    if (open) {
      requestId.current = crypto.randomUUID();
      prepare.reset();
      start.reset();
    }
  }, [open]);
  const plan = prepare.data;
  const ready = plan?.entries.filter((e) => e.status === "ready").length ?? 0;
  const error = prepare.error ?? start.error;
  const busy = prepare.isPending || start.isPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("ai_control.queue_title")}</DialogTitle>
          <DialogDescription>
            {t("ai_control.queue_description")}
          </DialogDescription>
        </DialogHeader>
        {config.isLoading && <p role="status">{t("ai_control.loading")}</p>}
        {!plan && config.data && (
          <div className="space-y-4">
            <label className="block space-y-2 text-sm">
              <span>{t("ai_control.route")}</span>
              <select
                className="w-full rounded-md border bg-background p-2"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="hybrid">
                  {t("ai_control.hybrid", { provider: config.data.provider })}
                </option>
                {config.data.localEnabled && (
                  <option value="local">{t("ai_control.local_only")}</option>
                )}
              </select>
            </label>
            {mode === "hybrid" ? (
              <label className="block space-y-2 text-sm">
                <span>{t("ai_control.target_model")}</span>
                <Input
                  value={model || config.data.model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("ai_control.model_hint", {
                    provider: config.data.provider,
                  })}
                </p>
              </label>
            ) : (
              <p className="break-all text-sm">{config.data.localModel}</p>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={refresh}
                onChange={(e) => setRefresh(e.target.checked)}
              />
              {t("ai_control.refresh_existing")}
            </label>
            {mode === "hybrid" && config.data.cloudMode === "off" && (
              <p className="rounded-lg bg-muted p-3 text-sm">
                {t("ai_control.cloud_paused_hint")}
              </p>
            )}
            <Button
              disabled={busy || !config.data.enabled}
              onClick={() =>
                prepare.mutate({
                  requestId: requestId.current ?? crypto.randomUUID(),
                  selection,
                  mode,
                  model: model || config.data!.model,
                  action: refresh ? "refresh" : "analyze",
                })
              }
            >
              {t("ai_control.review_batch")}
            </Button>
          </div>
        )}
        {plan && !start.isSuccess && (
          <div className="space-y-4">
            <p className="text-sm">
              {t("ai_control.batch_counts", {
                ready,
                skipped: plan.entries.length - ready,
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t(
                plan.mode === "local"
                  ? "ai_control.confirm_local"
                  : "ai_control.confirm_cost",
                { ready },
              )}
            </p>
            {plan.previousPaidAttempts > 0 && (
              <p className="rounded-lg bg-muted p-3 text-sm">
                {t("ai_control.previous_paid", {
                  count: plan.previousPaidAttempts,
                })}
              </p>
            )}
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border px-3">
              {plan.entries.map((entry) => (
                <li
                  key={entry.bookmarkId}
                  className="flex items-start justify-between gap-4 py-2 text-sm"
                >
                  <span className="line-clamp-2 break-all">{entry.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(
                      `ai_control.${entry.reason ? `reasons.${entry.reason}` : `statuses.${entry.status}`}`,
                      { defaultValue: t("ai_control.unknown") },
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                disabled={!ready || busy}
                onClick={() => start.mutate({ id: plan.id, action: "start" })}
              >
                {t("ai_control.enqueue", { count: ready })}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  prepare.reset();
                  requestId.current = crypto.randomUUID();
                }}
              >
                {t("ai_control.back")}
              </Button>
            </div>
          </div>
        )}
        {start.isSuccess && (
          <div className="space-y-3" role="status">
            <p>{t("ai_control.queued")}</p>
            <Button asChild>
              <Link href="/dashboard/ai" onClick={() => onOpenChange(false)}>
                {t("ai_control.open_queue")}
              </Link>
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        {config.error && (
          <p role="alert" className="text-sm text-destructive">
            {config.error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
