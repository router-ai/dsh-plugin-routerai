import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }

// Пакеты harness и pi-ai ставит сам DeepSeek Harness — в сборку они не попадают.
const hostPackages = [/^@deepseek-ai\//, /^@earendil-works\//]

export default defineConfig([
  // Серверная часть: обычный ESM-модуль для Node.
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node24',
    dts: false,
    clean: true,
    fixedExtension: false,
    external: hostPackages,
  },
  // Браузерная часть. Harness загружает клиентские модули через window.__ModuleLoader__:
  // модуль сообщает своё имя и фабрику, которой загрузчик передаёт require для общих пакетов
  // (react, компоненты harness). Обёртка добавляется к CommonJS-сборке прямо здесь.
  {
    entry: { client: 'src/client/main.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    tsconfig: 'tsconfig.client.json',
    external: ['react', 'react/jsx-runtime', 'react-dom', ...hostPackages],
    outExtensions: () => ({ js: '.js' }),
    outputOptions: {
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: function (require) { var module = { exports: {} }; var exports = module.exports;`,
      footer: 'return module.exports; } });',
    },
  },
])
