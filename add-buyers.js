const Database = require("better-sqlite3");
const db = new Database("forma.db");

try {
  db.pragma("foreign_keys = ON");

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS buyers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        delivery_address TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const columns = db.prepare("PRAGMA table_info(orders)").all();

    if (!columns.some(c => c.name === "buyer_id")) {
      db.exec(
        "ALTER TABLE orders ADD COLUMN buyer_id INTEGER REFERENCES buyers(id)"
      );
    }
  })();

  console.log("Миграция покупателей выполнена успешно.");
} finally {
  db.close();
}
