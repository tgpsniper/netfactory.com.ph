// RADIUS Database — PostgreSQL (local, same DB as main app)
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  }
  return pool;
}

// Mimics mysql2 interface: returns [rows]
async function query(sql, params = []) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => '$' + (++i));
  const result = await getPool().query(pgSql, params);
  return [result.rows];
}

// Transaction wrapper
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const conn = {
      query: async (sql, params = []) => {
        let i = 0;
        const pgSql = sql.replace(/\?/g, () => '$' + (++i));
        const result = await client.query(pgSql, params);
        return [result.rows];
      }
    };
    await fn(conn);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function disconnect() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, transaction, disconnect, getPool };
