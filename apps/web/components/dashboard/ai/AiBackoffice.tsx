"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { activeAiStatuses } from "@karakeep/shared/aiControl";
import type { AiBatchRequest, AiFilter } from "@karakeep/shared/aiControl";
import { useTranslation } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AiControls from "@/components/admin/AiControls";
import AiQueueDialog from "./AiQueueDialog";
import AiHistory from "./AiHistory";

export default function AiBackoffice({
  administration = false,
}: {
  administration?: boolean;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<AiFilter>({ status: "all" });
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [selection, setSelection] = useState<
    AiBatchRequest["selection"] | null
  >(null);
  const config = useQuery(
    api.ai.configuration.queryOptions(undefined, { refetchInterval: 10_000 }),
  );
  const cards = useQuery(
    api.ai.cards.queryOptions({ filter, offset }, { refetchInterval: 5000 }),
  );
  const models = useQuery(api.ai.models.queryOptions());
  const batches = useQuery(
    api.ai.batches.queryOptions(undefined, { refetchInterval: 5000 }),
  );
  const change = useMutation(
    api.ai.changeBatch.mutationOptions({
      onSuccess: async () => {
        await cache.invalidateQueries({ queryKey: api.ai.pathKey() });
      },
    }),
  );
  const updateFilter = (next: Partial<AiFilter>) => {
    setFilter({ ...filter, ...next });
    setOffset(0);
    setSelected([]);
  };
  const pageIds = cards.data?.items.map((c) => c.id) ?? [];
  const allSelected =
    pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const error = cards.error ?? config.error ?? batches.error ?? change.error;
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("ai_control.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("ai_control.subtitle")}
          </p>
        </div>
        {!administration && session.data?.user.role === "admin" && (
          <Button variant="outline" asChild>
            <Link href="/admin/ai">{t("ai_control.cloud_controls")}</Link>
          </Button>
        )}
      </header>
      {administration ? (
        <AiControls />
      ) : (
        config.data && (
          <p className="rounded-xl border bg-card p-4 text-sm">
            {t("ai_control.cloud_mode")}:{" "}
            <strong>{t(`ai_control.modes.${config.data.cloudMode}`)}</strong> ·{" "}
            {config.data.provider} · {config.data.model}
          </p>
        )
      )}
      {config.data && !config.data.enabled && (
        <p role="status" className="rounded-lg border p-4">
          {t("ai_control.disabled")}
        </p>
      )}
      <section className="space-y-4" aria-label={t("ai_control.cards")}>
        <h2 className="text-lg font-semibold">{t("ai_control.cards")}</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            updateFilter({ query });
          }}
        >
          <label className="min-w-48 flex-1 space-y-1 text-xs">
            <span>{t("ai_control.search")}</span>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span>{t("ai_control.status")}</span>
            <select
              className="block rounded-md border bg-background p-2 text-sm"
              value={filter.status}
              onChange={(e) =>
                updateFilter({ status: e.target.value as AiFilter["status"] })
              }
            >
              {(
                [
                  "all",
                  "missing",
                  "failed",
                  "active",
                  "success",
                  "needs_review",
                ] as const
              ).map((s) => (
                <option key={s} value={s}>
                  {t(`ai_control.filters.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="max-w-full space-y-1 text-xs">
            <span>{t("ai_control.result_model")}</span>
            <select
              className="block max-w-72 rounded-md border bg-background p-2 text-sm"
              value={
                filter.provider
                  ? JSON.stringify([filter.provider, filter.model ?? ""])
                  : ""
              }
              onChange={(e) => {
                if (!e.target.value) {
                  updateFilter({ provider: undefined, model: undefined });
                  return;
                }
                const [provider, model] = JSON.parse(e.target.value) as [
                  AiFilter["provider"],
                  string,
                ];
                updateFilter({ provider, model: model || undefined });
              }}
            >
              <option value="">{t("ai_control.all_models")}</option>
              {models.data?.map((m) => (
                <option
                  key={`${m.provider}:${m.model}`}
                  value={JSON.stringify([
                    m.provider ?? "unknown",
                    m.model ?? "",
                  ])}
                >
                  {m.provider
                    ? `${m.provider} · ${m.model}`
                    : t("ai_control.unknown")}{" "}
                  ({m.count})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span>{t("ai_control.analyzed_before")}</span>
            <Input
              type="date"
              value={filter.analyzedBefore?.slice(0, 10) ?? ""}
              onChange={(e) =>
                updateFilter({
                  analyzedBefore: e.target.value
                    ? new Date(`${e.target.value}T00:00:00Z`).toISOString()
                    : undefined,
                })
              }
            />
          </label>
          <Button type="submit" variant="outline">
            {t("ai_control.apply")}
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!selected.length || !config.data?.enabled}
            onClick={() => setSelection({ type: "ids", ids: selected })}
          >
            {t("ai_control.analyze_selected", { count: selected.length })}
          </Button>
          <Button
            variant="outline"
            disabled={
              !cards.data?.total ||
              cards.data.total > 200 ||
              !config.data?.enabled
            }
            onClick={() => setSelection({ type: "filter", filter })}
          >
            {t("ai_control.analyze_filter", { count: cards.data?.total ?? 0 })}
          </Button>
          {(cards.data?.total ?? 0) > 200 && (
            <p className="text-xs text-muted-foreground">
              {t("ai_control.batch_limit")}
            </p>
          )}
        </div>
        {cards.isLoading ? (
          <div
            role="status"
            className="h-64 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
          >
            <span className="sr-only">{t("ai_control.loading")}</span>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">
                    <input
                      type="checkbox"
                      aria-label={t("ai_control.select_page")}
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? [] : pageIds)}
                    />
                  </th>
                  <th className="p-3">{t("ai_control.card")}</th>
                  <th className="p-3">{t("ai_control.status")}</th>
                  <th className="p-3">{t("ai_control.result_model")}</th>
                  <th className="p-3">{t("ai_control.analyzed_at")}</th>
                  <th>
                    <span className="sr-only">{t("ai_control.history")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {cards.data?.items.map((card) => (
                  <tr key={card.id}>
                    <td className="p-3">
                      <input
                        type="checkbox"
                        aria-label={t("ai_control.select_card", {
                          title: card.title,
                        })}
                        checked={selected.includes(card.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, card.id]
                              : selected.filter((id) => id !== card.id),
                          )
                        }
                      />
                    </td>
                    <td className="min-w-48 max-w-sm p-3">
                      <Link
                        className="line-clamp-2 hover:underline"
                        href={`/dashboard/preview/${card.id}`}
                      >
                        {card.title}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {t(`ai_control.statuses.${card.status}`, {
                        defaultValue: t("ai_control.unknown"),
                      })}
                    </td>
                    <td className="max-w-56 break-all p-3 text-xs">
                      {card.source
                        ? `${card.source.provider} · ${card.source.resolvedModel ?? card.source.model}`
                        : t("ai_control.unknown")}
                    </td>
                    <td className="whitespace-nowrap p-3 text-xs text-muted-foreground">
                      {card.source?.analyzedAt
                        ? new Date(card.source.analyzedAt).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="p-2">
                      <AiHistory bookmarkId={card.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cards.data?.total === 0 && (
              <p className="p-8 text-center text-muted-foreground">
                {t("ai_control.empty")}
              </p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            {t("ai_control.total", { count: cards.data?.total ?? 0 })}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!offset}
              onClick={() => {
                setOffset(offset - 50);
                setSelected([]);
              }}
            >
              {t("ai_control.previous")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + 50 >= (cards.data?.total ?? 0)}
              onClick={() => {
                setOffset(offset + 50);
                setSelected([]);
              }}
            >
              {t("ai_control.next")}
            </Button>
          </div>
        </div>
      </section>
      <section className="space-y-3" aria-label={t("ai_control.batches")}>
        <h2 className="text-lg font-semibold">{t("ai_control.batches")}</h2>
        {!batches.isLoading &&
          !batches.data?.some((b) => b.status !== "draft") && (
            <p className="rounded-xl border p-6 text-sm text-muted-foreground">
              {t("ai_control.no_batches")}
            </p>
          )}
        {batches.data
          ?.filter((b) => b.status !== "draft")
          .map((batch) => {
            const pending = batch.entries.filter(
              (e) =>
                e.status === "ready" || activeAiStatuses.includes(e.status),
            ).length;
            const successful = batch.entries.filter(
              (e) => e.status === "success",
            ).length;
            return (
              <article
                key={batch.id}
                className="space-y-3 rounded-xl border bg-card p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="break-all text-sm font-medium">
                      {batch.mode === "local"
                        ? config.data?.localModel
                        : `${batch.provider} · ${batch.model}`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(batch.createdAt).toLocaleString()} ·{" "}
                      {t(`ai_control.batch_states.${batch.status}`)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {batch.status === "running" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate({ id: batch.id, action: "pause" })
                        }
                      >
                        {t("ai_control.pause")}
                      </Button>
                    )}
                    {batch.status === "paused" && (
                      <Button
                        size="sm"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate({ id: batch.id, action: "resume" })
                        }
                      >
                        {t("ai_control.resume")}
                      </Button>
                    )}
                    {["running", "paused"].includes(batch.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate({ id: batch.id, action: "cancel" })
                        }
                      >
                        {t("ai_control.cancel_pending")}
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-sm" role="status">
                  {t("ai_control.progress", {
                    successful,
                    pending,
                    total: batch.entries.length,
                  })}
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t("ai_control.show_items")}
                  </summary>
                  <ul className="mt-2 max-h-64 divide-y overflow-y-auto text-xs">
                    {batch.entries.map((e) => (
                      <li
                        className="flex justify-between gap-3 py-2"
                        key={e.bookmarkId}
                      >
                        <Link
                          className="truncate hover:underline"
                          href={`/dashboard/preview/${e.bookmarkId}`}
                        >
                          {e.title}
                        </Link>
                        <span className="shrink-0">
                          {t(
                            `ai_control.${e.reason ? `reasons.${e.reason}` : `statuses.${e.status}`}`,
                            { defaultValue: t("ai_control.unknown") },
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </article>
            );
          })}
      </section>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {selection && (
        <AiQueueDialog
          open
          onOpenChange={(open) => {
            if (!open) setSelection(null);
          }}
          selection={selection}
        />
      )}
    </main>
  );
}
