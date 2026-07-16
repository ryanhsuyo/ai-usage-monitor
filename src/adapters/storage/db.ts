// SqlDatabase implementations: Tauri SQLite (production) and an in-memory fake (tests).
//
// The Tauri implementation opens `sqlite:app.db`, which the SQL plugin resolves inside the app
// data directory (Tauri Path API — never a hardcoded path). Migrations are registered Rust-side
// and executed by the plugin on first load.

import type { SqlDatabase } from "@/ports";

let tauriDbPromise: Promise<SqlDatabase> | null = null;

export function getTauriDatabase(): Promise<SqlDatabase> {
  if (!tauriDbPromise) {
    tauriDbPromise = (async () => {
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const db = await Database.load("sqlite:app.db");
      return {
        async execute(sql, params) {
          await db.execute(sql, params);
        },
        async select<T>(sql: string, params?: unknown[]) {
          return (await db.select(sql, params)) as T[];
        },
      } satisfies SqlDatabase;
    })();
  }
  return tauriDbPromise;
}
