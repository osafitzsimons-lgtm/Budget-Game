import { usd } from '../../shared/money';
import type { ScreenProps } from '../app';
import { Progress } from '../components';

export const RULES = [
  'Pay savings first.',
  'Write down any negotiable of $30 or more before paying.',
  'Wait 48 hours on anything over $100 unless it’s urgent.',
  'No new games, boosts or kit until March.',
  'Delivery capped at $15 a week.',
  'Cash counts when it’s withdrawn.',
  'Upload by Sunday 8pm — even after a bad week.',
];

export function Negotiables({ state }: ScreenProps) {
  const m = state.month;
  const keys = Object.keys(m.caps);
  return (
    <div>
      <h1>Negotiables</h1>
      <div class="card">
        <h2>My rules</h2>
        <ol class="rules">{RULES.map((r) => <li>{r}</li>)}</ol>
      </div>
      <div class="card">
        <div class="row space"><h2>Delivery this week</h2><span class={m.delivery > state.settings.deliveryWeeklyCap ? 'bad' : ''}>{usd(m.delivery)} / {usd(state.settings.deliveryWeeklyCap)}</span></div>
        <Progress value={m.delivery} max={state.settings.deliveryWeeklyCap} />
      </div>
      <div class="card">
        <h2>Monthly caps · {m.month}</h2>
        <p class="muted">From uploaded statements so far this month.</p>
        <ul class="plain">
          {keys.map((k) => {
            const spent = m.capSpent[k] ?? 0;
            const cap = m.caps[k];
            return (
              <li>
                <div class="row space"><span>{k}</span><span class={`num ${spent > cap ? 'bad' : ''}`}>{usd(spent)} / {usd(cap)}</span></div>
                <Progress value={spent} max={cap} />
                {k === m.otherCapName && <small class="muted">Clothes and kit, Gaming, Medical, Unidentified, minus friends paying back.</small>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
