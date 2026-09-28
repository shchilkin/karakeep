"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";
import type {
  LocalCheckBatchView,
  LocalCheckSelection,
} from "@karakeep/shared/types/importLocalCheckBatch";
import { useTranslation } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function ImportLocalCheckBatches({
  selectedIds,
}: {
  selectedIds: string[];
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const [review, setReview] = useState<LocalCheckBatchView | null>(null);
  const batches = useQuery(
    api.deferredImport.localCheckBatches.queryOptions(undefined, {
      refetchInterval: 5000,
    }),
  );
  const refresh = () =>
    cache.invalidateQueries({ queryKey: api.deferredImport.pathKey() });
  const prepare = useMutation(
    api.deferredImport.prepareLocalCheckBatch.mutationOptions({
      retry: false,
      onSuccess: async (batch) => {
        setReview(batch);
        await refresh();
      },
    }),
  );
  const change = useMutation(
    api.deferredImport.changeLocalCheckBatch.mutationOptions({
      retry: false,
      onSuccess: async (batch) => {
        if (batch.status !== "draft") setReview(null);
        await refresh();
      },
    }),
  );
  const beginReview = (selection: LocalCheckSelection) => {
    change.reset();
    prepare.mutate({ requestId: crypto.randomUUID(), selection });
  };
  const error = prepare.error ?? change.error ?? batches.error;
  const pending = prepare.isPending || change.isPending;
  return (
    <section
      className="space-y-3 rounded-xl border bg-card p-4"
      aria-label={t("import_checks.title")}
    >
      <h2 className="text-lg font-semibold">{t("import_checks.title")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("import_checks.subtitle")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => beginReview({ type: "all" })}
        >
          {t("import_checks.review_all")}
        </Button>
        <Button
          variant="outline"
          disabled={pending || !selectedIds.length}
          onClick={() => beginReview({ type: "ids", ids: selectedIds })}
        >
          {t("import_checks.review_selected", { count: selectedIds.length })}
        </Button>
      </div>
      {batches.isLoading && <p role="status">{t("ai_control.loading")}</p>}
      {batches.data?.map((batch) => (
        <article key={batch.id} className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              {new Date(batch.createdAt).toLocaleString()} ·{" "}
              {t(`ai_control.batch_states.${batch.status}`)}
            </p>
            {batch.status === "draft" && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  change.reset();
                  setReview(batch);
                }}
              >
                {t("import_checks.review")}
              </Button>
            )}
            {batch.status === "running" && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => change.mutate({ id: batch.id, action: "pause" })}
              >
                {t("ai_control.pause")}
              </Button>
            )}
            {batch.status === "paused" && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  change.mutate({ id: batch.id, action: "resume" })
                }
              >
                {t("import_checks.resume")}
              </Button>
            )}
          </div>
          <progress
            className="w-full"
            aria-label={t("import_checks.progress_label")}
            value={
              batch.counts.complete + batch.counts.skipped + batch.counts.failed
            }
            max={Math.max(batch.total, 1)}
          />
          <p className="text-sm" role="status">
            {t("import_checks.progress", {
              ...batch.counts,
              total: batch.total,
            })}
          </p>
          {batch.status === "paused" && (
            <p className="text-xs text-muted-foreground">
              {t("import_checks.pause_hint")}
            </p>
          )}
          <Reasons batch={batch} />
          <BatchItems batch={batch} />
        </article>
      ))}
      {error && !review && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <Dialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open && !change.isPending) setReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("import_checks.confirm_title")}</DialogTitle>
            <DialogDescription>
              {t("import_checks.confirm_scope")}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">{t("import_checks.search_warning")}</p>
          <p className="text-sm text-muted-foreground">
            {t("import_checks.limits")}
          </p>
          {review && (
            <>
              <p className="text-sm font-medium">
                {t("import_checks.review_counts", {
                  ready: review.counts.ready,
                  skipped: review.counts.skipped,
                  total: review.total,
                })}
              </p>
              <Reasons batch={review} />
              <Button
                disabled={change.isPending || !review.counts.ready}
                onClick={() =>
                  change.mutate({ id: review.id, action: "start" })
                }
              >
                {t("import_checks.start")}
              </Button>
            </>
          )}
          {change.error && (
            <p role="alert" className="text-sm text-destructive">
              {change.error.message}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Reasons({ batch }: { batch: LocalCheckBatchView }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {Object.entries(batch.outcomeReasons).map(([reason, count]) => (
        <li key={reason}>
          {t(`import_checks.reasons.${reason}`, { defaultValue: reason })}:{" "}
          {count}
        </li>
      ))}
    </ul>
  );
}

function BatchItems({ batch }: { batch: LocalCheckBatchView }) {
  const { t } = useTranslation();
  const api = useTRPC();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const page = useQuery(
    api.deferredImport.localCheckBatchItems.queryOptions(
      { id: batch.id, offset, limit: 50 },
      {
        enabled: open,
        refetchInterval:
          open && (batch.status === "running" || batch.status === "paused")
            ? 5000
            : false,
      },
    ),
  );
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t("ai_control.show_items")}
      </Button>
      {open && (
        <>
          {page.isLoading && <p role="status">{t("ai_control.loading")}</p>}
          {page.error && (
            <p role="alert" className="text-sm text-destructive">
              {page.error.message}
            </p>
          )}
          <ul className="max-h-64 divide-y overflow-y-auto text-xs">
            {page.data?.items.map((item) => (
              <li
                key={item.bookmarkId}
                className="flex flex-wrap justify-between gap-2 py-2"
              >
                <Link
                  prefetch={false}
                  href={`/dashboard/preview/${item.bookmarkId}`}
                  className="break-all underline"
                >
                  {item.bookmarkId}
                </Link>
                <span>
                  {item.reason
                    ? t(`import_checks.reasons.${item.reason}`, {
                        defaultValue: item.reason,
                      })
                    : t(`import_checks.item_states.${item.state}`)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset((value) => Math.max(0, value - 50))}
            >
              {t("ai_control.previous")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!page.data || offset + 50 >= page.data.total}
              onClick={() => setOffset((value) => value + 50)}
            >
              {t("ai_control.next")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
