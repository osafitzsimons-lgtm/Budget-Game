import { useState } from 'preact/hooks';
import { toCsv, parseHistoryCsv } from '../../shared/csv';
import { hashRows } from '../../shared/hash';
import { usd } from '../../shared/money';
import type { Phase, Settings } from '../../shared/settings';
import { api } from '../api';
import type { ScreenProps } from '../app';

function NumberField({ label, value, onChange, step = '1' }: { label: string; value: number; onChange: (n: number) => void; step?: string }) {
  const id = `f-${label.replace(/\W+/g, '-')}`;
  return (
    <div>
      <label for={id}>{label}</label>
      <input id={id} type="number" inputMode="decimal" step={step} min="0" value={String(value)} onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} />
    </div>
  );
}

function PhaseEditor({ title, phases, onChange }: { title: string; phases: Phase<number>[]; onChange: (p: Phase<number>[]) => void }) {
  return (
    <div>
      <h3>{title}</h3>
      {phases.map((p, i) => (
        <div class="row" style={{ alignItems: 'flex-end' }}>
          <div class="grow">
            <NumberField label={p.until ? `Until ${p.until}` : i === 0 ? 'Always' : 'After that'} value={p.value} onChange={(v) => onChange(phases.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
          </div>
          {p.until && (
            <div class="grow">
              <label for={`until-${title}-${i}`}>Last day</label>
              <input id={`until-${title}-${i}`} type="date" value={p.until} onInput={(e) => onChange(phases.map((x, j) => (j === i ? { ...x, until: (e.target as HTMLInputElement).value || x.until } : x)))} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const lines = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export function SettingsScreen({ state, reload }: ScreenProps) {
  const [s, setS] = useState<Settings>(state.settings);
  const [kw, setKw] = useState(state.settings.savingsKeywords.join(', '));
  const [names, setNames] = useState(state.settings.ownNames.join(', '));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newAcct, setNewAcct] = useState({ bank: 'ABA', last3: '', label: '', optional: false });
  const [csvMsg, setCsvMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api.saveSettings({ ...s, savingsKeywords: lines(kw), ownNames: lines(names) });
      await reload();
      setMsg({ ok: true, text: 'Saved.' });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    setBusy(false);
  }

  async function saveAccount(a: Record<string, unknown>) {
    try { await api.saveAccount(a); await reload(); setMsg({ ok: true, text: 'Account saved.' }); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  }

  async function importCsv(file: File | undefined) {
    if (!file) return;
    setCsvMsg(null);
    const { rows, errors } = parseHistoryCsv(await file.text());
    if (errors.length) { setCsvMsg({ ok: false, text: `Nothing imported. ${errors.slice(0, 5).join(' ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}` }); return; }
    try {
      const hashes = await hashRows('csv', rows.map((r) => ({ date: r.date, time: null, payee: `${r.account}|${r.payee}`, amountOrig: r.amountUsd, balance: null })));
      let inserted = 0, skipped = 0, learned = 0;
      for (let i = 0; i < rows.length; i += 3000) {
        const res = await api.importCsv(rows.slice(i, i + 3000).map((r, j) => ({ ...r, hash: hashes[i + j] })));
        inserted += res.inserted; skipped += res.skipped; learned += res.rulesLearned;
      }
      await reload();
      setCsvMsg({ ok: true, text: `Imported ${inserted} rows (${skipped} already there). Learned ${learned} payee rules. History is filled in; health is not affected.` });
    } catch (e) { setCsvMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  }

  async function exportAll() {
    setExporting(true);
    try {
      const tables = ['transactions', 'logs', 'score_events', 'uploads', 'creatures', 'payee_rules'];
      const collected: { table: string; columns: string[]; rows: unknown[][] }[] = [];
      for (const t of tables) {
        let after = '';
        let columns: string[] = [];
        const all: unknown[][] = [];
        for (;;) {
          const page = await api.exportPage(t, after);
          columns = page.columns;
          all.push(...page.rows);
          if (page.done || !page.rows.length) break;
          after = String(page.rows[page.rows.length - 1][columns.length - 1]);
        }
        const keep = columns.filter((c) => c !== 'cursor');
        collected.push({ table: t, columns: keep, rows: all.map((r) => keep.map((c) => r[columns.indexOf(c)])) });
      }
      const union = [...new Set(collected.flatMap((c) => c.columns))];
      const out: unknown[][] = [];
      for (const c of collected) for (const r of c.rows) out.push([c.table, ...union.map((u) => { const i = c.columns.indexOf(u); return i < 0 ? '' : r[i]; })]);
      const blob = new Blob([toCsv(['record_type', ...union], out)], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `budget-guy-export-${state.today}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    setExporting(false);
  }

  const capKeys = Object.keys(s.caps[0]?.value ?? {});

  return (
    <div>
      <h1>Settings</h1>
      {msg && <div class={`notice ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}

      <div class="card">
        <h2>Sprout</h2>
        <label for="name">Name</label>
        <input id="name" value={s.creatureName} maxLength={40} onInput={(e) => setS({ ...s, creatureName: (e.target as HTMLInputElement).value })} />
      </div>

      <div class="card">
        <h2>Budget</h2>
        <PhaseEditor title="Weekly negotiable allowance ($)" phases={s.allowance} onChange={(allowance) => setS({ ...s, allowance })} />
        <PhaseEditor title="Monthly savings target ($)" phases={s.savingsTarget} onChange={(savingsTarget) => setS({ ...s, savingsTarget })} />
        <NumberField label="Delivery cap per week ($)" value={s.deliveryWeeklyCap} onChange={(v) => setS({ ...s, deliveryWeeklyCap: v })} />
        <h3>Monthly caps ($)</h3>
        <table>
          <thead><tr><th>Category</th>{s.caps.map((p) => <th class="r">{p.until ? `to ${p.until.slice(0, 7)}` : 'after'}</th>)}</tr></thead>
          <tbody>
            {capKeys.map((k) => (
              <tr>
                <td>{k}</td>
                {s.caps.map((p, i) => (
                  <td class="r" style={{ width: '84px' }}>
                    <input aria-label={`${k} cap ${i + 1}`} type="number" inputMode="decimal" min="0" value={String(p.value[k] ?? 0)} onInput={(e) => setS({ ...s, caps: s.caps.map((x, j) => (j === i ? { ...x, value: { ...x.value, [k]: Number((e.target as HTMLInputElement).value) } } : x)) })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Money</h2>
        <NumberField label="GBP → USD rate (Revolut)" step="0.01" value={s.fxGbpUsd} onChange={(v) => setS({ ...s, fxGbpUsd: v })} />
        <small class="muted">Used for new uploads. Already-saved rows keep the rate they were saved with.</small>
        <label for="sav">Savings account</label>
        <select id="sav" value={s.savingsAccountId} onChange={(e) => setS({ ...s, savingsAccountId: (e.target as HTMLSelectElement).value })}>
          <option value="">Not nominated</option>
          {state.accounts.map((a) => <option value={a.id}>{a.label}</option>)}
        </select>
        <label for="kw">Other savings payee words (comma separated)</label>
        <input id="kw" value={kw} onInput={(e) => setKw((e.target as HTMLInputElement).value)} placeholder="e.g. Savings pot" />
        <label for="names">Your name as banks print it (comma separated)</label>
        <input id="names" value={names} onInput={(e) => setNames((e.target as HTMLInputElement).value)} placeholder="Used to spot transfers between your own accounts" />
        <NumberField label="Savings count from this day of the previous month" value={s.savingsWindowStartDay} onChange={(v) => setS({ ...s, savingsWindowStartDay: Math.round(v) })} />
      </div>

      <button class="full" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>

      <div class="card" style={{ marginTop: 12 }}>
        <h2>Accounts</h2>
        <ul class="plain">
          {state.accounts.map((a) => (
            <li>
              <div class="row space"><strong>{a.label}</strong><small class="muted">{a.bank === 'REV' ? 'Revolut' : 'ABA'} ending {a.last3}</small></div>
              <label class="check"><input type="checkbox" checked={a.optional} onChange={(e) => saveAccount({ ...a, optional: (e.target as HTMLInputElement).checked })} /> Optional (no penalty if missing)</label>
              <label class="check"><input type="checkbox" checked={a.active} onChange={(e) => saveAccount({ ...a, active: (e.target as HTMLInputElement).checked })} /> Active</label>
            </li>
          ))}
        </ul>
        <h3>Add an account</h3>
        <div class="row">
          <select aria-label="Bank" value={newAcct.bank} onChange={(e) => setNewAcct({ ...newAcct, bank: (e.target as HTMLSelectElement).value })}>
            <option value="ABA">ABA</option>
            <option value="REV">Revolut</option>
          </select>
          <input aria-label="Last 3 digits" inputMode="numeric" maxLength={3} placeholder="Last 3 digits" value={newAcct.last3} onInput={(e) => setNewAcct({ ...newAcct, last3: (e.target as HTMLInputElement).value.replace(/\D/g, '') })} />
        </div>
        <label for="nlabel">Name</label>
        <input id="nlabel" value={newAcct.label} onInput={(e) => setNewAcct({ ...newAcct, label: (e.target as HTMLInputElement).value })} placeholder="e.g. ABA savings" />
        <label class="check"><input type="checkbox" checked={newAcct.optional} onChange={(e) => setNewAcct({ ...newAcct, optional: (e.target as HTMLInputElement).checked })} /> Optional</label>
        <button class="full secondary" disabled={newAcct.last3.length !== 3} onClick={() => saveAccount({ ...newAcct, label: newAcct.label || undefined, active: true }).then(() => setNewAcct({ bank: 'ABA', last3: '', label: '', optional: false }))}>Add account</button>
        <p class="muted">Only the last 3 digits are stored.</p>
      </div>

      <div class="card">
        <h2>Import history (CSV)</h2>
        <p class="muted">Columns: <code>date,account,payee,amount_usd,category</code>. Spending is positive, money in negative. Teaches payee rules and fills History. Never affects health. Safe to import twice.</p>
        <input type="file" accept=".csv,text/csv" aria-label="History CSV" onChange={(e) => { void importCsv((e.target as HTMLInputElement).files?.[0]); (e.target as HTMLInputElement).value = ''; }} />
        {csvMsg && <div class={`notice ${csvMsg.ok ? 'good' : 'bad'}`}>{csvMsg.text}</div>}
      </div>

      <div class="card">
        <h2>Export everything</h2>
        <p class="muted">Downloads one CSV with every transaction, note, score change, upload and rule.</p>
        <button class="full secondary" disabled={exporting} onClick={exportAll}>{exporting ? 'Preparing…' : 'Download CSV'}</button>
      </div>

      <p class="muted">Scoring started the week of {s.scoringStart}. Before {s.halveNegativesBefore}, health losses are halved. Allowance now {usd(state.week.allowance)} a week.</p>
    </div>
  );
}
