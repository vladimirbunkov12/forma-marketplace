
const Database = require("better-sqlite3");
const path = require("path");

// Подключаем существующую базу FORMA
const db = new Database(
  path.join(__dirname, "forma.db")
);

// Включаем связи между таблицами
db.pragma("foreign_keys = ON");

// Таблица мебельных компаний
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    city TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pickup_address TEXT NOT NULL DEFAULT '',
    commission_agreement_version TEXT,
    commission_agreement_accepted_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const companyColumns = db.prepare("PRAGMA table_info(companies)").all();
if (!companyColumns.some(column => column.name === "pickup_address")) {
  db.exec("ALTER TABLE companies ADD COLUMN pickup_address TEXT NOT NULL DEFAULT ''");
}

if (!companyColumns.some(column => column.name === "commission_agreement_version")) {
  db.exec("ALTER TABLE companies ADD COLUMN commission_agreement_version TEXT");
}

if (!companyColumns.some(column => column.name === "commission_agreement_accepted_at")) {
  db.exec("ALTER TABLE companies ADD COLUMN commission_agreement_accepted_at TEXT");
}

// Индивидуальная комиссия продавца (5% = 500 bps)
const sellerCommissionColumns = db.prepare(
  "PRAGMA table_info(companies)"
).all();

if (!sellerCommissionColumns.some(
  column => column.name === "commission_rate_bps"
)) {
  db.exec(`
    ALTER TABLE companies
    ADD COLUMN commission_rate_bps INTEGER NOT NULL DEFAULT 500
    CHECK (commission_rate_bps BETWEEN 0 AND 1500)
  `);
}

// Статус блокировки продавца FORMA
const updatedCompanyColumns = db.prepare(
  "PRAGMA table_info(companies)"
).all();

if (!updatedCompanyColumns.some(column => column.name === "is_blocked")) {
  db.exec(`
    ALTER TABLE companies
    ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0
  `);
}

const migrateSellerDeliverySettings = db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seller_delivery_settings (
      company_id INTEGER PRIMARY KEY,
      yandex_api_key_encrypted TEXT,
      pickup_city TEXT,
      pickup_address TEXT,
      payment_by TEXT NOT NULL DEFAULT 'seller'
        CHECK (payment_by IN ('seller', 'buyer')),
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )
  `);

  const sellerDeliveryColumns = db.prepare(
    "PRAGMA table_info(seller_delivery_settings)"
  ).all();

  if (!sellerDeliveryColumns.some(column => column.name === "payment_by")) {
    db.exec(`
      ALTER TABLE seller_delivery_settings
      ADD COLUMN payment_by TEXT NOT NULL DEFAULT 'seller'
        CHECK (payment_by IN ('seller', 'buyer'))
    `);
  }
});

migrateSellerDeliverySettings();

// История предложений изменения комиссии продавца
db.exec(`
  CREATE TABLE IF NOT EXISTS commission_change_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    old_rate_bps INTEGER NOT NULL
      CHECK (old_rate_bps BETWEEN 0 AND 1500),
    new_rate_bps INTEGER NOT NULL
      CHECK (new_rate_bps BETWEEN 500 AND 1500),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'stale')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TEXT,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS
    idx_commission_proposals_company_history
    ON commission_change_proposals(company_id, id DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS
    idx_commission_proposals_one_pending_per_company
    ON commission_change_proposals(company_id)
    WHERE status = 'pending';
`);

// Администраторы FORMA MARKETPLACE
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Таблица товаров
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL CHECK(price > 0),
    description TEXT NOT NULL,
    photo TEXT NOT NULL,
    weight_kg REAL,
    length_cm REAL,
    width_cm REAL,
    height_cm REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (company_id)
      REFERENCES companies(id)
      ON DELETE CASCADE
  )
`);

const productColumns = db.prepare("PRAGMA table_info(products)").all();
for (const column of ["weight_kg", "length_cm", "width_cm", "height_cm"]) {
  if (!productColumns.some(existingColumn => existingColumn.name === column)) {
    db.exec(`ALTER TABLE products ADD COLUMN ${column} REAL`);
  }
}

// Индекс для поиска товаров компании
db.exec(`
  CREATE INDEX IF NOT EXISTS
  idx_products_company
  ON products(company_id)
`);

// Bootstrap missing tables on a clean installation; existing rows are preserved.
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

CREATE TABLE IF NOT EXISTS buyers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL, password_hash TEXT NOT NULL, delivery_address TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS seller_prices (company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE, kitchen_per_meter INTEGER NOT NULL DEFAULT 0, wardrobe_per_sqm INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
if (!db.prepare("PRAGMA table_info(buyers)").all().some(c => c.name === "delivery_address")) db.exec("ALTER TABLE buyers ADD COLUMN delivery_address TEXT NOT NULL DEFAULT ''");
if (!db.prepare("PRAGMA table_info(orders)").all().some(c => c.name === "buyer_id")) db.exec("ALTER TABLE orders ADD COLUMN buyer_id INTEGER REFERENCES buyers(id)");
if (!db.prepare("PRAGMA table_info(order_items)").all().some(c => c.name === "dimensions")) db.exec("ALTER TABLE order_items ADD COLUMN dimensions TEXT");
// Комиссия FORMA — единая ставка 5%
const orderColumns = db.prepare("PRAGMA table_info(orders)").all();

if (orderColumns.length > 0) {
  if (!orderColumns.some(column => column.name === "commission_rate_bps")) {
    db.exec(`
      ALTER TABLE orders
      ADD COLUMN commission_rate_bps INTEGER NOT NULL DEFAULT 0
    `);
  }

  if (!orderColumns.some(column => column.name === "commission_amount")) {
    db.exec(`
      ALTER TABLE orders
      ADD COLUMN commission_amount INTEGER NOT NULL DEFAULT 0
    `);
  }

  if (!orderColumns.some(column => column.name === "seller_amount")) {
    db.exec(`
      ALTER TABLE orders
      ADD COLUMN seller_amount INTEGER NOT NULL DEFAULT 0
    `);
  }

  if (!orderColumns.some(column => column.name === "payment_status")) {
    db.exec(`
      ALTER TABLE orders
      ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'awaiting_payment'
      CHECK (payment_status IN ('awaiting_payment', 'paid_test'))
    `);
  }

  if (!orderColumns.some(column => column.name === "payment_test_marked_at")) {
    db.exec(`
      ALTER TABLE orders
      ADD COLUMN payment_test_marked_at TEXT
    `);
  }
}

// Платёжные реквизиты продавца доступны только через API компании из сессии.
db.exec(`
  CREATE TABLE IF NOT EXISTS seller_payment_details (
    company_id INTEGER PRIMARY KEY,
    business_type TEXT NOT NULL
      CHECK (business_type IN ('ip', 'too')),
    business_identifier TEXT NOT NULL
      CHECK (length(business_identifier) = 12),
    bank_name TEXT NOT NULL,
    iban TEXT NOT NULL
      CHECK (length(iban) = 20),
    is_demo INTEGER NOT NULL DEFAULT 0
      CHECK (is_demo IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
`);

const paymentDetailColumns = db.prepare(
  "PRAGMA table_info(seller_payment_details)"
).all();
if (paymentDetailColumns.length > 0 &&
    !paymentDetailColumns.some(column => column.name === "is_demo")) {
  db.exec(`
    ALTER TABLE seller_payment_details
    ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0
    CHECK (is_demo IN (0, 1))
  `);
}

const deliveryColumns = db.prepare("PRAGMA table_info(deliveries)").all();
if (deliveryColumns.length > 0 &&
    !deliveryColumns.some(column => column.name === "is_demo")) {
  db.exec(`
    ALTER TABLE deliveries
    ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0
    CHECK (is_demo IN (0, 1))
  `);
}

// Единая ставка комиссии FORMA (500 базисных пунктов = 5%)
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rate_bps INTEGER NOT NULL
  )
`);

db.prepare(`
  INSERT OR IGNORE INTO platform_settings (id, rate_bps)
  VALUES (1, 500)
`).run();

// Реквизиты платформы FORMA (хранятся отдельно от реквизитов продавцов).
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_payment_details (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_name TEXT,
    bin_iin TEXT,
    legal_address TEXT,
    phone TEXT,
    email TEXT,
    bank_name TEXT,
    bik TEXT,
    iban TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.prepare(`
  INSERT OR IGNORE INTO platform_payment_details (id)
  VALUES (1)
`).run();

// Корзина покупателя (хранится между посещениями, привязана к buyer_id из сессии)
db.exec(`
  CREATE TABLE IF NOT EXISTS buyer_cart (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1 AND quantity <= 100),
    dimensions TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE(buyer_id, product_id)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_buyer_cart_buyer
  ON buyer_cart(buyer_id)
`);

module.exports = db;
