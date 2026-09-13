"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { useTranslation } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function AiControls() {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const controls = useQuery(
    api.ai.controls.queryOptions(undefined, { refetchInterval: 10_000 }),
  );
  const [draft, setDraft] = useState<{
    cloudMode: "off" | "manual" | "auto";
    dailyRequests: number;
    expectedRevision: number;
  } | null>(null);
  const save = useMutation(
    api.ai.updateControls.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        await cache.invalidateQueries({ queryKey: api.ai.pathKey() });
      },
    }),
  );
  const c = controls.data;
  if (!c)
    return (
      <p role={controls.error ? "alert" : "status"}>
        {controls.error?.message ?? t("ai_control.loading")}
      </p>
    );
  const value = draft ?? {
    cloudMode: c.cloudMode,
    dailyRequests: c.dailyRequests,
    expectedRevision: c.revision,
  };
  return (
    <section
      className="space-y-4 rounded-xl border bg-card p-5"
      aria-label={t("ai_control.cloud_controls")}
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold">{t("ai_control.cloud_controls")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("ai_control.quota_used", { used: c.used, limit: c.dailyRequests })}
        </p>
      </div>
      <div className="grid items-end gap-4 sm:grid-cols-[1fr_10rem_auto]">
        <label className="space-y-2 text-sm">
          <span>{t("ai_control.cloud_mode")}</span>
          <select
            className="block w-full rounded-md border bg-background p-2"
            value={value.cloudMode}
            onChange={(e) =>
              setDraft({
                ...value,
                cloudMode: e.target.value as typeof value.cloudMode,
              })
            }
          >
            <option value="off">{t("ai_control.modes.off")}</option>
            <option value="manual">{t("ai_control.modes.manual")}</option>
            <option value="auto">{t("ai_control.modes.auto")}</option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span>{t("ai_control.daily_limit")}</span>
          <Input
            type="number"
            min={1}
            max={c.ceiling}
            value={value.dailyRequests}
            onChange={(e) =>
              setDraft({ ...value, dailyRequests: e.target.valueAsNumber })
            }
          />
        </label>
        <Button
          disabled={
            !draft ||
            save.isPending ||
            !Number.isInteger(value.dailyRequests) ||
            value.dailyRequests < 1 ||
            value.dailyRequests > c.ceiling
          }
          onClick={() => save.mutate(value)}
        >
          {t("ai_control.save")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("ai_control.controls_hint", { ceiling: c.ceiling })}
      </p>
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && !draft && (
        <p role="status" className="text-sm">
          {t("ai_control.saved")}
        </p>
      )}
    </section>
  );
}
