import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en'
import ru from './locales/ru'

export const SUPPORTED_LANGUAGES = [
    { code: 'en', nativeName: 'English' },
    { code: 'ru', nativeName: 'Русский' },
] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code']

void i18n.use(initReactI18next).init({
    resources: {
        en: { translation: en },
        ru: { translation: ru },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: {
        // React already handles XSS
        escapeValue: false,
    },
})

export default i18n
