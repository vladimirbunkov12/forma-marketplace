
const db = require("./database");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_phone TEXT NOT NULL,
    delivery_country TEXT NOT NULL DEFAULT 'Kazakhstan',
    delivery_city TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    comment TEXT DEFAULT '',
    total_amount INTEGER NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'awaiting_payment'
      CHECK (payment_status IN ('awaiting_payment', 'paid_test')),
    payment_test_marked_at TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (company_id)
      REFERENCES companies(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL,

    FOREIGN KEY (order_id)
      REFERENCES orders(id) ON DELETE CASCADE,

    FOREIGN KEY (product_id)
      REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL UNIQUE,
    delivery_mode TEXT NOT NULL DEFAULT 'automatic',
    delivery_provider TEXT NOT NULL DEFAULT 'yandex',
    payment_by TEXT NOT NULL DEFAULT 'seller',
    country TEXT NOT NULL DEFAULT 'Kazakhstan',
    delivery_cost INTEGER,
    delivery_status TEXT NOT NULL DEFAULT 'not_requested',
    is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
    provider_order_id TEXT,
    tracking_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (order_id)
      REFERENCES orders(id) ON DELETE CASCADE
  );
`);

console.log("Таблицы заказов и доставки созданы!");

db.close();
