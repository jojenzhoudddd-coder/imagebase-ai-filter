import { createContext, useContext, useMemo, ReactNode, createElement } from "react";
import { en } from "./en";
import { zh } from "./zh";

export type Locale = "en" | "zh";

const STORAGE_KEY = "app_lang";

const translations: Record<Locale, typeof en> = { en, zh };

export function getLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  return "en";
}

export function setLocale(locale: Locale): void {
  localStorage.setItem(STORAGE_KEY, locale);
  window.location.reload();
}

type TFunction = (key: string, vars?: Record<string, string | number>) => string;

interface LanguageContextValue {
  locale: Locale;
  t: TFunction;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const locale = getLocale();
  const messages = translations[locale];
  const enMessages = translations.en;

  const t: TFunction = useMemo(() => {
    return (key: string, vars?: Record<string, string | number>): string => {
      let str = (messages as any)[key] ?? (enMessages as any)[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        }
      }
      return str;
    };
  }, [locale]);

  return createElement(LanguageContext.Provider, { value: { locale, t } }, children);
}

export function useTranslation(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useTranslation must be used within LanguageProvider");
  return ctx;
}

// Re-export for convenience
export type { TranslationKeys } from "./en";
