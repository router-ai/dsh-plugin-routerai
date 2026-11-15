// Сравнивает версию пакетов DeepSeek Harness, с которой плагин собирается, со свежей в npm.
// Печатает строки `pinned=…`, `newest=…` и `install=…` (пакеты для установки новой версии)
// в формате, который понимает $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PROBE = '@deepseek-ai/dsh-llm-pi-ai'
const { devDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Свежие сборки harness выходят под меткой `next`; `latest` у части пакетов давно не обновляется.
const tags = JSON.parse(execFileSync('npm', ['view', PROBE, 'dist-tags', '--json'], { encoding: 'utf8' }))
const newest = tags.next ?? tags.latest
const harnessPackages = Object.keys(devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))

console.log(`pinned=${devDependencies[PROBE]}`)
console.log(`newest=${newest}`)
console.log(`install=${harnessPackages.map(name => `${name}@${newest}`).join(' ')}`)
