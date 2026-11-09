import { useEffect, useState } from 'preact/hooks';
import { usd } from '../shared/money';
import { lookFor } from '../shared/scoring';
import { lineFor, speechFor, Sprout } from './creature';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts from `from` to `to`, so the health change is visible. */
export function useAnimatedNumber(from: number, to: number, ms = 1400): number {
  const [v, setV] = useState(from);
  useEffect(() => {
    if (reducedMotion() || from === to) { setV(to); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    const delay = setTimeout(() => { raf = requestAnimationFrame(tick); }, 400);
    return () => { clearTimeout(delay); cancelAnimationFrame(raf); };
  }, [from, to, ms]);
  return v;
}

export function HealthBar({ health }: { health: number }) {
  const cls = health < 40 ? 'over' : health < 60 ? 'near' : '';
  return (
    <div class="health-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={health} aria-label="Health">
      <div class={`bar ${cls}`}><span style={{ width: `${Math.max(0, Math.min(100, health))}%` }} /></div>
    </div>
  );
}

/** Creature with an animated health change (e.g. after an upload). */
export function CreatureView({ name, before, after, died }: { name: string; before: number; after: number; died?: boolean }) {
  // If he died, animate down to 0 first, then show the new sprout.
  const target = died ? 0 : after;
  const shown = useAnimatedNumber(before, target);
  const [reborn, setReborn] = useState(false);
  useEffect(() => {
    setReborn(false);
    if (!died) return;
    const t = setTimeout(() => setReborn(true), reducedMotion() ? 0 : 2600);
    return () => clearTimeout(t);
  }, [died, before, after]);
  const h = reborn ? after : shown;
  const reaction = before === after ? null : after < before || died ? 'hurt' : 'happy';
  const look = lookFor(h);
  return (
    <div class="creature-wrap">
      <Sprout health={h} reaction={reaction} label={lineFor(look, name)} />
      <div class="health">{name}: <span class="num">{h}</span>/100</div>
      <HealthBar health={h} />
      <p class="muted">{lineFor(look, name)}</p>
      <div class="speech" aria-live="polite">“{speechFor(look)}”</div>
    </div>
  );
}

export function Delta({ d }: { d: number }) {
  if (d === 0) return <span class="delta muted">±0</span>;
  return <span class={`delta ${d > 0 ? 'good' : 'bad'}`}>{d > 0 ? `+${d}` : d}</span>;
}

export function EventList({ events }: { events: { kind: string; delta: number; reason: string }[] }) {
  return (
    <ul class="plain events">
      {events.map((e) => (
        <li class="row" style={{ alignItems: 'flex-start' }}>
          <Delta d={e.delta} />
          <span class="grow">{e.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function Money({ n, signed }: { n: number; signed?: boolean }) {
  return <span class={`num ${signed ? (n < 0 ? 'bad' : 'good') : ''}`}>{usd(n)}</span>;
}

export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : value > 0 ? 100 : 0;
  const cls = pct > 100 ? 'over' : pct > 80 ? 'near' : '';
  return <div class={`bar ${cls}`}><span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>;
}
