// Адрес API. Для деплоя задаётся в .env.local: NEXT_PUBLIC_API_URL=https://api.example.com
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '')
