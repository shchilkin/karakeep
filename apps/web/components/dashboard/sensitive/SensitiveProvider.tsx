"use client";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import type { SensitivityMode } from "@karakeep/shared/sensitiveContent";
import type { SensitiveBookmark } from "@karakeep/shared/sensitiveVisibility";
import {
  concealSensitiveBookmark,
  sensitiveRevealKey,
} from "@karakeep/shared/sensitiveVisibility";
import { UserLocalSettingsCtx } from "@/lib/userLocalSettings/bookmarksLayout";
import { updateSensitivityMode } from "@/lib/userLocalSettings/userLocalSettings";
import { useTranslation } from "@/lib/i18n/client";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";

const SESSION_KEY = "karakeep-sensitive-ack-v1";
interface SensitiveContext {
  mode: SensitivityMode;
  pending: boolean;
  acknowledged: boolean;
  sectionOpen: boolean;
  setSectionOpen: (open: boolean) => void;
  requestAccess: () => void;
  setMode: (mode: SensitivityMode) => void;
  conceal: (bookmark: SensitiveBookmark) => boolean;
  reveal: (bookmark: SensitiveBookmark) => void;
}
const Context = createContext<SensitiveContext | null>(null);
export function useSensitiveContent() {
  const context = useContext(Context);
  if (!context) throw new Error("SensitiveProvider is required");
  return context;
}

export function SensitiveProvider({ children }: { children: React.ReactNode }) {
  const settings = useContext(UserLocalSettingsCtx);
  const pathname = usePathname();
  const { t } = useTranslation();
  const [mode, setModeState] = useState(settings.sensitivityMode);
  const [pending, setPending] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [confirmation, setConfirmation] = useState<"all" | "section" | null>(
    null,
  );
  useEffect(() => {
    try {
      setAcknowledged(sessionStorage.getItem(SESSION_KEY) === "yes");
    } catch {
      /* In-memory consent still works. */
    }
  }, []);
  const saveMode = async (next: SensitivityMode) => {
    const previous = mode;
    setRevealed(new Set());
    setModeState(next);
    setPending(true);
    try {
      await updateSensitivityMode(next);
    } catch {
      setModeState(previous);
      toast({ variant: "destructive", description: t("sensitive.save_error") });
    } finally {
      setPending(false);
    }
  };
  const setMode = (next: SensitivityMode) => {
    if (pending) return;
    if (next === "all" && !acknowledged) setConfirmation("all");
    else void saveMode(next);
  };
  // A saved 'all' preference alone never bypasses the new-session warning.
  const effectiveMode = mode === "all" && !acknowledged ? "balanced" : mode;
  // Route check closes the feed immediately, before section cleanup effects.
  const sectionAllowsPreview =
    sectionOpen &&
    acknowledged &&
    (pathname === "/dashboard/sensitive" ||
      pathname.startsWith("/dashboard/preview/"));
  return (
    <Context.Provider
      value={{
        mode,
        pending,
        acknowledged,
        sectionOpen: sectionAllowsPreview,
        setSectionOpen,
        setMode,
        requestAccess: () => setConfirmation("section"),
        conceal: (b) =>
          !sectionAllowsPreview &&
          !revealed.has(sensitiveRevealKey(b)) &&
          concealSensitiveBookmark(b, effectiveMode),
        reveal: (b) =>
          setRevealed((previous) =>
            new Set(previous).add(sensitiveRevealKey(b)),
          ),
      }}
    >
      {children}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t("sensitive.warning_title")}</DialogTitle>
          <DialogDescription>
            {t("sensitive.warning_description")}
          </DialogDescription>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmation(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              onClick={() => {
                setAcknowledged(true);
                try {
                  sessionStorage.setItem(SESSION_KEY, "yes");
                } catch {
                  /* Session only. */
                }
                if (confirmation === "all") void saveMode("all");
                setConfirmation(null);
              }}
            >
              {t("sensitive.continue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}
