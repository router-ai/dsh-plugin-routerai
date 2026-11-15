// Переносит icon.svg в src/client/logo.ts, чтобы знак был встроен в браузерную сборку.
import { readFileSync, writeFileSync } from 'node:fs'

const svg = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8').trim()
const source = `// Знак RouterAI из icon.svg в виде data-URI (файл собирается командой npm run logo).
export const LOGO = ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(svg)}`)}
`
writeFileSync(new URL('../src/client/logo.ts', import.meta.url), source)
