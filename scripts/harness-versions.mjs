// Сравнивает версию пакетов DeepSeek Harness, с которой плагин собирается, со свежей в npm.
// Печатает строки `pinned=…`, `newest=…` и `install=…` (пакеты для установки новой версии)
// в формате, который понимает $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PROBE = '@deepseek-ai/dsh-llm-pi-ai'
const { devDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Сравнение версий вида 0.2.3-alpha.2: сначала числа, затем предварительная метка (без метки — старше). */
function compare(a, b) {
  const parse = (version) => {
    const [main, pre = ''] = version.split('-')
    return { main: main.split('.').map(Number), pre: pre === '' ? null : pre.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)) }
  }
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) if ((x.main[i] ?? 0) !== (y.main[i] ?? 0)) return (x.main[i] ?? 0) - (y.main[i] ?? 0)
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    if (x.pre[i] === y.pre[i]) continue
    if (x.pre[i] === undefined) return -1
    if (y.pre[i] === undefined) return 1
    return x.pre[i] > y.pre[i] ? 1 : -1
  }
  return 0
}

// Сборки harness выходят под разными метками (`latest`, `next`, `alpha`): несовместимость раньше всего
// появляется в самой новой, поэтому берём старшую версию из всех меток.
const tags = JSON.parse(execFileSync('npm', ['view', PROBE, 'dist-tags', '--json'], { encoding: 'utf8' }))
const newest = Object.values(tags).sort(compare).at(-1)
const harnessPackages = Object.keys(devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))

console.log(`pinned=${devDependencies[PROBE]}`)
console.log(`newest=${newest}`)
console.log(`install=${harnessPackages.map(name => `${name}@${newest}`).join(' ')}`)
