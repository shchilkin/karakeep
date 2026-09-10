import Bookmarks from "@/components/dashboard/bookmarks/Bookmarks";
import SensitiveSection from "@/components/dashboard/sensitive/SensitiveSection";
import { useTranslation } from "@/lib/i18n/server";
export const metadata = { title: "Sensitive | Karakeep" };
export default async function SensitivePage() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return (
    <SensitiveSection>
      <Bookmarks
        header={<h1 className="text-2xl">{t("sensitive.section_title")}</h1>}
        query={{ sensitive: true }}
        showDivider
        showEditorCard={false}
      />
    </SensitiveSection>
  );
}
