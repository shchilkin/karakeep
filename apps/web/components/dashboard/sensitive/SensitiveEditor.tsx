"use client";
import type { SensitiveCategory } from "@karakeep/shared/sensitiveContent";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { useUpdateBookmark } from "@karakeep/shared-react/hooks/bookmarks";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { sensitiveCategories } from "@karakeep/shared/sensitiveContent";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n/client";

function EditorForm({
  bookmark,
  close,
}: {
  bookmark: ZBookmark;
  close: () => void;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const cache = useQueryClient();
  const [categories, setCategories] = useState<SensitiveCategory[]>(
    bookmark.sensitiveCategories ?? [],
  );
  const { mutate, isPending, error } = useUpdateBookmark({
    onSuccess: (updated) => {
      cache.setQueryData(
        api.bookmarks.getBookmark.queryKey({ bookmarkId: bookmark.id }),
        updated,
      );
      close();
    },
  });
  return (
    <>
      <DialogTitle>{t("sensitive.edit")}</DialogTitle>
      <DialogDescription>{t("sensitive.edit_description")}</DialogDescription>
      <label className="flex items-center justify-between gap-4 font-medium">
        {t("sensitive.mark")}
        <Switch
          checked={categories.length > 0}
          disabled={isPending}
          onCheckedChange={(on) => setCategories(on ? ["other"] : [])}
        />
      </label>
      {categories.length > 0 && (
        <fieldset
          disabled={isPending}
          className="grid max-h-[45dvh] gap-2 overflow-auto sm:grid-cols-2"
        >
          <legend className="sr-only">{t("sensitive.categories_label")}</legend>
          {sensitiveCategories.map((category) => (
            <label
              key={category}
              className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm"
            >
              <input
                type="checkbox"
                checked={categories.includes(category)}
                className="size-4 accent-primary"
                onChange={(event) =>
                  setCategories((previous) =>
                    event.target.checked
                      ? [
                          ...previous.filter(
                            (value) =>
                              value !== "other" || category === "other",
                          ),
                          category,
                        ]
                      : previous.filter((value) => value !== category),
                  )
                }
              />
              {t(`sensitive.categories.${category}`)}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("sensitive.save_error")}
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" disabled={isPending} onClick={close}>
          {t("actions.cancel")}
        </Button>
        <Button
          disabled={isPending}
          onClick={() =>
            mutate({ bookmarkId: bookmark.id, sensitiveCategories: categories })
          }
        >
          {t(isPending ? "sensitive.saving" : "actions.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
export default function SensitiveEditor({
  bookmark,
  open,
  setOpen,
}: {
  bookmark: ZBookmark;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <EditorForm bookmark={bookmark} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
