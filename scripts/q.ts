/**
 * scripts/q.ts — run SQL against a NanoMika database without the sqlite3 CLI.
 *
 * Usage:
 *   pnpm exec tsx scripts/q.ts <db-path> "<sql>"
 *
 * Uses better-sqlite3's stmt.reader property to distinguish queries
 * (SELECT / WITH...SELECT) from mutations. Queries print rows in
 * sqlite3 CLI default ("list") format — pipe-separated, no header.
 * Mutations run via stmt.run() (single statement) or db.exec() (compound).
 *
 * Why this exists: NanoMika does not depend on the sqlite3 CLI binary,
 * which is missing on many fresh hosts. This wrapper goes through the
 * better-sqlite3 dependency the host already uses.
 */
import Database from 'better-sqlite3';

const [, , dbPath, sql] = process.argv;

if (!dbPath || sql === undefined) {
  console.error('Usage: pnpm exec tsx scripts/q.ts <db-path> "<sql>"');
  process.exit(2);
}

const db = new Database(dbPath);
try {
  try {
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.all() as Record<string, unknown>[];
      for (const row of rows) {
        console.log(
          Object.values(row)
            .map((v) => (v === null ? '' : String(v)))
            .join('|'),
        );
      }
    } else {
      stmt.run();
    }
  } catch (e: unknown) {
    // better-sqlite3 throws on compound statements ("contains more than
    // one statement"). Compound SQL in skills is always mutations
    // (e.g. "DELETE ...; INSERT ...;"), so fall back to db.exec().
    if (e instanceof Error && /more than one statement/i.test(e.message)) {
      db.exec(sql);
    } else {
      throw e;
    }
  }
} finally {
  db.close();
}
