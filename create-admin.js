const bcrypt = require("bcryptjs");
const db = require("./database");

async function createAdmin() {
  const email = (process.env.FORMA_ADMIN_EMAIL || "").trim().toLowerCase(); if (!email || !email.includes("@")) throw new Error("Admin email required");
  const password = process.env.FORMA_ADMIN_PASSWORD;

  if (!password || password.length < 12) {
    throw new Error("Пароль должен содержать минимум 12 символов.");
  }

  const existing = db.prepare(
    "SELECT id FROM admin_users WHERE email = ?"
  ).get(email);

  if (existing) {
    throw new Error("Администратор уже существует.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  db.prepare(`
    INSERT INTO admin_users (email, password_hash)
    VALUES (?, ?)
  `).run(email, passwordHash);

  console.log("Администратор FORMA успешно создан.");
}

createAdmin()
  .catch(error => {
    console.error("Ошибка:", error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
