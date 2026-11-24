
const db = require("./database");

const columns = db.prepare(
  "PRAGMA table_info(order_items)"
).all();

if (!columns.some(column => column.name === "dimensions")) {
  db.exec(`
    ALTER TABLE order_items
    ADD COLUMN dimensions TEXT
  `);
}

console.log("Поле размеров заказа готово!");

db.close();
