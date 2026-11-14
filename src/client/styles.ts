// Оформление элементов плагина. Цвета, шрифты и скругления берутся из переменных темы harness
// (--dsw-*), поэтому интерфейс выглядит родным в светлой и тёмной теме.
const ACCENT = '#2d67f6'

const SHEET = `
.rai-page{display:grid;gap:18px;padding-bottom:28px;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}
.rai-head{display:grid;grid-template-columns:auto 1fr;column-gap:12px;align-items:center}
.rai-head h2{margin:0;font:var(--dsw-font-l-20)}
.rai-head p{margin:0;grid-column:2;color:var(--dsw-alias-label-secondary)}
.rai-panel{display:grid;gap:12px;padding:16px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill)}
.rai-panel>h3{margin:0;font:var(--dsw-font-s-strong-14)}
.rai-note{margin:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}
.rai-faint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.rai-alert{margin:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-error-primary)}
.rai-caution{margin:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-warn-label)}
.rai-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rai-line>.rai-fill{flex:1 1 160px;min-width:0}
.rai-clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rai-figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.rai-figure{display:grid;gap:2px;padding:10px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3)}
.rai-figure>strong{font:var(--dsw-font-l-20)}
.rai-figure.rai-main{border-color:${ACCENT}}
.rai-gauge{height:3px;border-radius:2px;background:var(--dsw-alias-border-l2)}
.rai-gauge>span{display:block;height:100%;border-radius:2px;background:${ACCENT}}
.rai-rows{display:grid;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l3);overflow:hidden}
.rai-rows.rai-tall{max-height:380px;overflow-y:auto}
.rai-row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:8px 10px}
.rai-row+.rai-row{border-top:1px solid var(--dsw-alias-border-l2)}
.rai-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
label.rai-row{cursor:pointer}
.rai-row input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:${ACCENT}}
.rai-order{width:1.5em;text-align:right;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.rai-tools{display:flex;gap:2px}
.rai-tools button{all:unset;display:grid;place-items:center;width:26px;height:26px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.rai-tools button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rai-tools button:disabled{opacity:.3;cursor:default}
.rai-choice{height:36px;padding:0 8px;font:inherit;color:inherit;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}
.rai-side{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}
.rai-side:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rai-side>span{flex:1}
.rai-side>b{font-weight:500;color:var(--dsw-alias-label-primary)}
.rai-side.rai-compact{width:auto;justify-content:center}
.rai-side.rai-warn,.rai-side.rai-warn>b{color:var(--dsw-alias-state-warn-label)}
.rai-cost{position:relative;display:inline-flex}
.rai-cost>button{all:unset;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:12px;cursor:pointer;white-space:nowrap;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.rai-cost>button:hover{color:var(--dsw-alias-label-primary)}
.rai-sheet{position:absolute;z-index:60;right:0;bottom:calc(100% + 8px);width:300px;max-width:calc(100vw - 24px);box-sizing:border-box;display:grid;gap:8px;padding:12px 14px;border-radius:var(--dsw-radius-md);font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 12px 32px rgba(0,0,0,.18)}
.rai-sheet dl{display:grid;grid-template-columns:1fr auto;gap:4px 14px;margin:0}
.rai-sheet dt{color:var(--dsw-alias-label-secondary)}
.rai-sheet dd{margin:0;text-align:right;font-weight:500}
.rai-sheet ul{display:grid;gap:2px;margin:0;padding:6px 0 0;list-style:none;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.rai-sheet li{display:flex;gap:8px}
.rai-sheet li>span{flex:1;min-width:0}
.rai-banner{display:flex;align-items:center;gap:12px;max-width:540px;padding:12px 14px;border-radius:var(--dsw-radius-md);font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 8px 24px rgba(0,0,0,.14)}
.rai-banner>div{flex:1;min-width:0;display:grid;gap:2px}
.rai-drawn{display:grid;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-md);font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3)}
.rai-gallery{display:flex;flex-wrap:wrap;gap:8px}
.rai-gallery img,.rai-gallery i{display:block;max-width:min(320px,100%);max-height:320px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.rai-gallery i{width:200px;height:200px}
.rai-busy{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:${ACCENT};animation:rai-turn .8s linear infinite}
@keyframes rai-turn{to{transform:rotate(1turn)}}
`

/** Подключить стили. Атрибуты data-plugin* — соглашение harness: по ним он снимает стили выгруженного плагина. */
export function mountStyles(owner: string): () => void {
  const element = document.createElement('style')
  element.dataset['plugin'] = owner
  element.dataset['pluginCss'] = `${owner}/styles`
  element.textContent = SHEET
  document.head.append(element)
  return () => { element.remove() }
}
