// Мелкие общие детали интерфейса.
import { LOGO } from './logo.ts'

export function Logo({ size }: { size: number }) {
  return <img src={LOGO} width={size} height={size} alt="" style={{ display: 'block', flexShrink: 0 }} />
}

type Glyph = 'up' | 'down' | 'cross'

const SHAPES: Record<Glyph, string> = {
  up: 'M3.5 9.5 8 5l4.5 4.5',
  down: 'M3.5 6.5 8 11l4.5-4.5',
  cross: 'M4.5 4.5l7 7m0-7-7 7',
}

export function Icon({ glyph }: { glyph: Glyph }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={SHAPES[glyph]} />
    </svg>
  )
}
