
const pool = require("./postgres");
const { AsyncLocalStorage } = require("async_hooks");
const storage = new AsyncLocalStorage();

function prepare(sql) {
  let n = 0;
  sql = sql.replace(/\?/g, () => "$" + (++n));
  sql = sql.replace(/CURRENT_TIMESTAMP/g, "CURRENT_TIMESTAMP::text");

  async function query(args, returning = false) {
    const client = storage.getStore() || pool;
    return client.query(
      sql + (returning ? " RETURNING id" : ""),
      args
    );
  }

  return {
    async get(...args) {
      return (await query(args)).rows[0];
    },
    async all(...args) {
      return (await query(args)).rows;
    },
    async run(...args) {
      const insert = /^\s*INSERT INTO (orders|buyer_cart|commission_change_proposals|products|companies)\s*\(/i.test(sql);
      const result = await query(args, insert);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0]?.id
      };
    }
  };
}

function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await storage.run(client, () => fn(...args));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}

module.exports = { prepare, transaction };
