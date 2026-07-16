// In-memory SqlDatabase fake for repository tests (no SQLite binary needed in jsdom).
//
// It implements just enough SQL to exercise the repository layer faithfully: INSERT (with
// ON CONFLICT upsert), UPDATE, DELETE, SELECT with WHERE/ORDER BY/LIMIT/COUNT, plus the unique
// (event_key, channel_id) dedup index from the real schema. Not a general SQL engine.

import type { SqlDatabase } from "@/ports";

type Row = Record<string, unknown>;

const TABLES = [
  "provider_accounts",
  "subscription_plans",
  "usage_limits",
  "usage_snapshots",
  "usage_activities",
  "reset_events",
  "data_source_status",
  "scheduler_runs",
  "notification_channels",
  "notification_events",
  "notification_deliveries",
  "app_settings",
] as const;

export class FakeSqlDatabase implements SqlDatabase {
  public tables = new Map<string, Row[]>();

  constructor() {
    for (const t of TABLES) this.tables.set(t, []);
  }

  private tableFor(sql: string): { name: string; rows: Row[] } {
    const m = /(?:FROM|INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i.exec(sql);
    const name = m?.[1] ?? "";
    const rows = this.tables.get(name);
    if (!rows) throw new Error(`FakeSqlDatabase: unknown table in SQL: ${sql.slice(0, 80)}`);
    return { name, rows };
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const trimmed = sql.trim();

    if (/^INSERT INTO/i.test(trimmed)) {
      const { name, rows } = this.tableFor(trimmed);
      const colsMatch = /\(([^)]+)\)\s*VALUES/i.exec(trimmed);
      if (!colsMatch) throw new Error("FakeSqlDatabase: cannot parse INSERT columns");
      const cols = (colsMatch[1] as string).split(",").map((c) => c.trim());
      const row: Row = {};
      cols.forEach((c, i) => (row[c] = params[i] ?? null));

      const hasUpsert = /ON CONFLICT/i.test(trimmed);
      const pk = name === "app_settings" ? "key" : "id";
      const existingIdx = rows.findIndex((r) => r[pk] === row[pk]);

      // Enforce the real schema's unique dedup index.
      if (name === "notification_deliveries") {
        const dup = rows.some(
          (r) => r.event_key === row.event_key && r.channel_id === row.channel_id
        );
        if (dup) throw new Error("UNIQUE constraint failed: uq_delivery_eventkey_channel");
      }

      if (existingIdx >= 0) {
        if (hasUpsert) {
          rows[existingIdx] = { ...rows[existingIdx], ...row };
          return;
        }
        throw new Error(`UNIQUE constraint failed: ${name}.${pk}`);
      }
      rows.push(row);
      return;
    }

    if (/^UPDATE/i.test(trimmed)) {
      const { rows } = this.tableFor(trimmed);
      const setMatch = /SET\s+(.+?)\s+WHERE\s+(.+)$/is.exec(trimmed);
      if (!setMatch) throw new Error("FakeSqlDatabase: cannot parse UPDATE");
      const setCols = (setMatch[1] as string).split(",").map((p) => p.split("=")[0]?.trim() ?? "");
      const whereCol = ((setMatch[2] as string).split("=")[0] ?? "").trim();
      const whereVal = params[params.length - 1];
      for (const r of rows) {
        if (r[whereCol] === whereVal) {
          setCols.forEach((c, i) => (r[c] = params[i] ?? null));
        }
      }
      return;
    }

    if (/^DELETE FROM/i.test(trimmed)) {
      const { name, rows } = this.tableFor(trimmed);
      const whereMatch = /WHERE\s+([a-z_]+)\s*=\s*\?/i.exec(trimmed);
      if (!whereMatch) {
        this.tables.set(name, []);
        return;
      }
      const col = whereMatch[1] as string;
      this.tables.set(
        name,
        rows.filter((r) => r[col] !== params[0])
      );
      return;
    }

    throw new Error(`FakeSqlDatabase: unsupported SQL: ${trimmed.slice(0, 80)}`);
  }

  async select<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const trimmed = sql.trim();
    const { rows } = this.tableFor(trimmed);

    let filtered = [...rows];

    // WHERE with one or more `col = ?` / `col >= ?` joined by AND
    const whereMatch = /WHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|$)/is.exec(trimmed);
    if (whereMatch) {
      const conds = (whereMatch[1] as string).split(/\s+AND\s+/i);
      let p = 0;
      for (const cond of conds) {
        const m = /([a-z_]+)\s*(>=|=)\s*(\?|'[^']*'|\d+)/i.exec(cond.trim());
        if (!m) continue;
        const [, col, op, rhs] = m as unknown as [string, string, string, string];
        let value: unknown;
        if (rhs === "?") {
          value = params[p++];
        } else if (rhs.startsWith("'")) {
          value = rhs.slice(1, -1);
        } else {
          value = Number(rhs);
        }
        filtered = filtered.filter((r) => {
          const cell = r[col];
          if (op === ">=") return String(cell) >= String(value);
          // loose eq to cover 1 vs "1" for booleans
          return cell === value || String(cell) === String(value);
        });
      }
    }

    // COUNT(*)
    const countMatch = /SELECT\s+COUNT\(\*\)\s+as\s+(\w+)/i.exec(trimmed);
    if (countMatch) {
      return [{ [countMatch[1] as string]: filtered.length } as T];
    }

    // ORDER BY col [DESC]
    const orderMatch = /ORDER BY\s+([a-z_]+)(\s+DESC)?/i.exec(trimmed);
    if (orderMatch) {
      const col = orderMatch[1] as string;
      const desc = Boolean(orderMatch[2]);
      filtered.sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return desc ? bv.localeCompare(av) : av.localeCompare(bv);
      });
    }

    // LIMIT n
    const limitMatch = /LIMIT\s+(\d+)/i.exec(trimmed);
    if (limitMatch) {
      filtered = filtered.slice(0, Number(limitMatch[1]));
    }

    // Column projection: only `SELECT a, b FROM` (not `SELECT *`)
    const projMatch = /^SELECT\s+(?!\*)([a-z_,\s]+?)\s+FROM/i.exec(trimmed);
    if (projMatch && !countMatch) {
      const cols = (projMatch[1] as string).split(",").map((c) => c.trim());
      filtered = filtered.map((r) => {
        const out: Row = {};
        for (const c of cols) out[c] = r[c];
        return out;
      });
    }

    return filtered as T[];
  }
}
