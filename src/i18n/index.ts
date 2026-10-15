import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, getInitialLanguage, normalizeLanguage } from './language';

import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

const resources = {
  'zh-CN': {
    translation: zhCN
  },
  'en-US': {
    translation: enUS
  }
};

let initialLanguage = DEFAULT_LANGUAGE;
try {
  if (typeof window !== 'undefined') initialLanguage = getInitialLanguage(window.localStorage);
} catch {
  // Storage can be disabled by the WebView or browser privacy settings.
}

i18n
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: ['en-US', 'zh-CN'],
    lng: initialLanguage,
    interpolation: {
      escapeValue: false
    },
    // 避免 SSR hydration 不匹配：在服务器端跳过语言检测
    react: {
      useSuspense: false
    }
  });

const updateDocumentLanguage = (language: string) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  }
};
updateDocumentLanguage(i18n.language);
i18n.on('languageChanged', updateDocumentLanguage);

export default i18n;

