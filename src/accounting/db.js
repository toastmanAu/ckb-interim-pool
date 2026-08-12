'use strict';
/**
 * db.js — PostgreSQL pool (system of record). Thin pg wrapper + migrate.
 */

const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

function createDb(connectionString) {
  const pool = new Pool({ connectionString, max: 10 });
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    /** Run all db/migrations/*.sql in order, skipping applied ones. */
    async migrate(migrationsDir) {
      await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const applied = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
      for (const f of files) {
        if (applied.has(f)) continue;
        const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${f} failed: ${e.message}`);
        } finally {
          client.release();
        }
      }
    },
    async close() { await pool.end(); },
  };
}

module.exports = { createDb };
