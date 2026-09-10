"use client";
import { EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslation } from "@/lib/i18n/client";
import { useSensitiveContent } from "./SensitiveProvider";

export default function SensitiveModeControl() {
  const { t } = useTranslation();
  const { mode, pending, acknowledged, sectionOpen, setMode } =
    useSensitiveContent();
  const displayedMode = mode === "all" && !acknowledged ? "balanced" : mode;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="gap-2 px-2"
          aria-label={t("sensitive.mode_label")}
        >
          <EyeOff size={19} />
          <span className="hidden text-sm lg:inline">
            {t(`sensitive.modes.${displayedMode}`)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <p className="font-medium">{t("sensitive.mode_label")}</p>
        <div
          role="radiogroup"
          aria-label={t("sensitive.mode_label")}
          className="flex rounded-lg bg-muted p-1"
        >
          {(["work", "balanced", "all"] as const).map((value) => (
            <label key={value} className="flex-1 cursor-pointer">
              <input
                type="radio"
                name="sensitivity-mode"
                value={value}
                className="peer sr-only"
                checked={displayedMode === value}
                disabled={pending}
                onChange={() => setMode(value)}
              />
              <span className="block rounded-md px-1 py-2 text-center text-sm peer-checked:bg-background peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50">
                {t(`sensitive.modes.${value}`)}
              </span>
            </label>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          {t(`sensitive.mode_help.${displayedMode}`)}
        </p>
        {sectionOpen && (
          <p className="text-sm">{t("sensitive.section_notice")}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("sensitive.manual_only")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
