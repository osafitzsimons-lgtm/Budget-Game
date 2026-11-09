import { useEffect, useState } from 'preact/hooks';
import { formatDate, weekEnd } from '../../shared/dates';
import { usd } from '../../shared/money';
import type { ScreenProps } from '../app';
import { CreatureView, EventList, Money, Progress } from '../components';

function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

export function Home({ state, go }: ScreenProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const s = state;
  const ls = s.lastScoring;
  const left = s.week.left;
  const until = s.deadline.at - now;
  const deathNotice = s.savings.extra > 0 || s.savings.nextMonthExtra > 0;
  const missing = s.requiredAccounts.filter((id) => {
    const u = s.uploads.find((x) => x.accountId === id);
    return !u?.lastGood || u.lastGood.periodEnd < weekEnd(s.deadline.weekStart);
  });

  return (
    <div>
      <div class="card">
        <CreatureView name={s.creature.name} before={ls ? ls.before : s.creature.health} after={s.creature.health} died={ls?.died} />
        {ls && ls.events.length > 0 && (
          <div class="notice warn" style={{ marginTop: 12 }}>
            <strong>While you were away</strong>
            <EventList events={ls.events} />
          </div>
        )}
      </div>

      {deathNotice && (
        <div class="notice bad">
          <strong>{usd(s.savings.extra + s.savings.nextMonthExtra)} extra to savings next payday.</strong>{' '}
          A sprout died. That money is added to your savings target.
        </div>
      )}

      <div class="card">
        <div class="row space">
          <div>
            <small>Money left this week</small>
            <div class={`big ${left < 0 ? 'bad' : ''}`}>{usd(left)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <small>of {usd(s.week.allowance)}</small>
            <div class="muted">{formatDate(s.week.start)} – {formatDate(s.week.end)}</div>
          </div>
        </div>
        <Progress value={s.week.spent + s.week.pending} max={s.week.allowance} />
        <p class="muted">
          Spent <Money n={s.week.spent} /> in uploaded statements{s.week.pending > 0 && <> + <Money n={s.week.pending} /> written down</>}.
        </p>
        {s.week.unloggedSoFar.length > 0 && (
          <p class="bad">{s.week.unloggedSoFar.length} spend{s.week.unloggedSoFar.length > 1 ? 's' : ''} of $30+ weren't written down first (−5 each at the deadline).</p>
        )}
      </div>

      <div class="card">
        <div class="row space">
          <div>
            <small>Statements due</small>
            <div class="big">{countdown(until)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <small>Sunday 8pm</small>
            <div class="muted">{new Date(s.deadline.at).toLocaleString('en-GB', { timeZone: 'Asia/Phnom_Penh', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        </div>
        {missing.length > 0 ? (
          <p>Still needed: {missing.map((id) => s.accounts.find((a) => a.id === id)?.label ?? id).join(', ')}.</p>
        ) : (
          <p class="good">All statements are in for this week.</p>
        )}
        <button class="full" onClick={() => go('upload')}>Upload statements</button>
      </div>

      <div class="card">
        <small>Saved for {s.savings.month} (by the 3rd)</small>
        <div class="row space">
          <div class="big">{usd(s.savings.saved)}</div>
          <div class="muted">target {usd(s.savings.target)}</div>
        </div>
        <Progress value={s.savings.saved} max={s.savings.target} />
        {!s.settings.savingsAccountId && s.settings.savingsKeywords.length === 0 && (
          <p class="warn">Nominate your savings account in Settings so savings can be counted.</p>
        )}
        <p class="muted">Counts money moved to savings from {formatDate(s.savings.from)} to {formatDate(s.savings.to)}.</p>
      </div>
    </div>
  );
}
