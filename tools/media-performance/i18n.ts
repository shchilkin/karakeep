import { createInstance } from "i18next";
import en from "../../apps/web/lib/i18n/locales/en/translation.json";
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } } });
export const useTranslation = () => ({ t: i18n.t.bind(i18n) });
