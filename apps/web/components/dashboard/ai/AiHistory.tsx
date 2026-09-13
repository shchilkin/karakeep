"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { useTranslation } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function AiHistory({ bookmarkId }: { bookmarkId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const api = useTRPC();
  const history = useQuery(
    api.ai.history.queryOptions({ bookmarkId }, { enabled: open }),
  );
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("ai_control.history")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("ai_control.history")}</DialogTitle>
            <DialogDescription>
              {t("ai_control.history_hint")}
            </DialogDescription>
          </DialogHeader>
          {history.isLoading && <p role="status">{t("ai_control.loading")}</p>}
          {history.error && <p role="alert">{history.error.message}</p>}
          <ol className="divide-y">
            {history.data?.map((run) => (
              <li key={run.id} className="space-y-2 py-3 text-sm">
                <div className="flex justify-between gap-3">
                  <strong>{t(`ai_control.statuses.${run.status}`)}</strong>
                  {run.current && (
                    <span className="text-muted-foreground">
                      {t("ai_control.current")}
                    </span>
                  )}
                </div>
                <p className="break-all">
                  {t("ai_control.requested")}:{" "}
                  {run.requestedProvider ?? t("ai_control.unknown")} ·{" "}
                  {run.requestedModel}
                </p>
                {run.source && (
                  <>
                    <p className="break-all">
                      {t("ai_control.saved_result")}: {run.source.provider} ·{" "}
                      {run.source.resolvedModel ?? run.source.model}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {run.source.analyzedAt
                        ? new Date(run.source.analyzedAt).toLocaleString()
                        : t("ai_control.unknown_date")}
                    </p>
                    {run.source.catalogVersion !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        {t("ai_control.catalog_version")}:{" "}
                        {run.source.catalogVersion}
                      </p>
                    )}
                    {run.source.sampledImages !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        {t("ai_control.coverage", {
                          sampled: run.source.sampledImages,
                          assets: run.source.assetCount ?? "?",
                        })}
                      </p>
                    )}
                    {run.source.revision && (
                      <p className="break-all text-xs text-muted-foreground">
                        {t("ai_control.revision")}: {run.source.revision}
                      </p>
                    )}
                  </>
                )}
                {run.localModel && (
                  <p className="break-all text-xs text-muted-foreground">
                    {t("ai_control.classifier")}: {run.localModel} ·{" "}
                    {run.localRevision ?? t("ai_control.unknown")}
                  </p>
                )}
                {run.localPolicy && (
                  <p className="text-xs text-muted-foreground">
                    {t("ai_control.local_policy")}: {run.localPolicy}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>
    </>
  );
}
