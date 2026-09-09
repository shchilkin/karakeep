"use client";
import { useEffect } from "react";
import { EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import { useSensitiveContent } from "./SensitiveProvider";

function OpenSection({ children }: { children: React.ReactNode }) {
  const { setSectionOpen } = useSensitiveContent();
  const { t } = useTranslation();
  // The underlying page stays mounted while an intercepted preview is open.
  useEffect(() => {
    setSectionOpen(true);
    return () => setSectionOpen(false);
  }, [setSectionOpen]);
  return (
    <>
      <p className="mb-4 rounded-lg border p-3 text-sm text-muted-foreground">
        {t("sensitive.section_notice")}
      </p>
      {children}
    </>
  );
}
export default function SensitiveSection({
  children,
}: {
  children: React.ReactNode;
}) {
  const { acknowledged, requestAccess } = useSensitiveContent();
  const { t } = useTranslation();
  if (acknowledged) return <OpenSection>{children}</OpenSection>;
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 py-20 text-center">
      <EyeOff className="size-8 text-muted-foreground" />
      <h1 className="text-2xl">{t("sensitive.section_title")}</h1>
      <p className="text-muted-foreground">
        {t("sensitive.warning_description")}
      </p>
      <Button onClick={requestAccess}>{t("sensitive.open_section")}</Button>
    </div>
  );
}
