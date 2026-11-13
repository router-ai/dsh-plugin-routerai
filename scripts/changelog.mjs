// Печатает заметки одной версии из CHANGELOG.md — они становятся текстом релиза на GitHub.
//   node scripts/changelog.mjs 0.1.0
import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (version === undefined) {
  console.error('Укажите версию: node scripts/changelog.mjs 1.2.3')
  process.exit(2)
}

const sections = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/^## /m).slice(1)
const section = sections.find(text => text.split('\n', 1)[0].trim().split(/\s/)[0] === version)
if (section === undefined) {
  console.error(`В CHANGELOG.md нет раздела «## ${version}»`)
  process.exit(1)
}
console.log(section.slice(section.indexOf('\n') + 1).trim())
