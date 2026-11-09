// From the security audit: an in-process D1 stand-in on node:sqlite, used to measure Worker-side CPU.
// Minimal in-process D1 stand-in on node:sqlite, used only to measure Worker-side CPU.
// Time spent inside SQLite is accumulated separately so it can be subtracted (in production that work
// happens in D1, not in the Worker isolate).
import { DatabaseSync } from 'node:sqlite';

export function sqliteD1() {
  const sql = new DatabaseSync(':memory:');
  const meter = { sqlMs: 0, queries: 0 };
  const timed = <T>(f: () => T): T => {
    const t = performance.now();
    try { return f(); } finally { meter.sqlMs += performance.now() - t; }
  };
  const isRead = (q: string) => /^\s*(SELECT|WITH)/i.test(q);
  const exec = (q: string, params: unknown[]) =>
    timed(() => {
      const st = sql.prepare(q);
      if (isRead(q)) return { results: st.all(...(params as any[])), success: true, meta: { changes: 0 } };
      const r = st.run(...(params as any[]));
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    });
  const stmt = (q: string, params: unknown[] = []): any => ({
    __q: q,
    __p: params,
    bind: (...a: unknown[]) => stmt(q, a.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v))),
    all: async () => { meter.queries++; return exec(q, params); },
    run: async () => { meter.queries++; return exec(q, params); },
    first: async (col?: string) => {
      meter.queries++;
      const r = exec(q, params).results[0] as Record<string, unknown> | undefined;
      return r === undefined ? null : col ? r[col] : r;
    },
    raw: async (o?: { columnNames?: boolean }) => {
      meter.queries++;
      return timed(() => {
        const st = sql.prepare(q);
        const cols = st.columns().map((c) => c.name);
        const rows = st.all(...(params as any[])).map((r: any) => cols.map((c) => r[c]));
        return o?.columnNames ? [cols, ...rows] : rows;
      });
    },
  });
  const db: any = {
    prepare: (q: string) => stmt(q),
    batch: async (stmts: any[]) => {
      meter.queries++;
      timed(() => sql.exec('BEGIN'));
      try {
        const out = stmts.map((s) => exec(s.__q, s.__p));
        timed(() => sql.exec('COMMIT'));
        return out;
      } catch (e) {
        timed(() => sql.exec('ROLLBACK'));
        throw e;
      }
    },
  };
  return { db: db as D1Database, meter };
}
