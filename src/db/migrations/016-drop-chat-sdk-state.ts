import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// The Chat SDK bridge was removed. This drops its state tables from DBs that
// ran the old 002 migration.
export const migration016: Migration = {
  version: 16,
  name: 'drop-chat-sdk-state',
  up: (db: Database.Database) => {
    db.exec(`
      DROP TABLE IF EXISTS chat_sdk_kv;
      DROP TABLE IF EXISTS chat_sdk_subscriptions;
      DROP TABLE IF EXISTS chat_sdk_locks;
      DROP TABLE IF EXISTS chat_sdk_lists;
    `);
  },
};
