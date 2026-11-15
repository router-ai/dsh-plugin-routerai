// Адреса RouterAI. Модуль без зависимостей — его подключает и браузерная часть.
export const API_BASE = 'https://routerai.ru/api/v1'
export const KEYS_PAGE = 'https://routerai.ru/settings/keys'
export const BILLING_PAGE = 'https://routerai.ru/settings/billing'
export const MODELS_PAGE = 'https://routerai.ru/models'

/** Имя инструмента рисования — по нему же браузерная часть подставляет свою карточку вызова. */
export const DRAW_TOOL = 'routerai_draw_image'
/** Имя инструмента, снимающего видео. */
export const VIDEO_TOOL = 'routerai_make_video'
/** Имя инструмента озвучки текста. */
export const SPEAK_TOOL = 'routerai_speak'
/** Папка в рабочем каталоге проекта, куда сохраняются картинки, видео и аудио. */
export const MEDIA_FOLDER = 'routerai-media'

/** Идентификатор маршрута в harness: так провайдер называется в пикере и конфигурации. */
export const ROUTE = 'routerai'
