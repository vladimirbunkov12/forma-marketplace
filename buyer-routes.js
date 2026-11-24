"use strict";

const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");

const buyerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Слишком много попыток входа. Попробуйте позже через 15 минут."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

function registerBuyerRoutes(app, db) {

  app.post("/api/buyer/register", async (req, res) => {
    try {
      const { name, email, phone, password } = req.body || {};

      if (
        typeof name !== "string" ||
        typeof email !== "string" ||
        typeof phone !== "string" ||
        typeof password !== "string" ||
        !name.trim() ||
        !phone.trim() ||
        name.trim().length > 150 ||
        phone.trim().length > 30 ||
        email.length > 254 ||
        password.length < 8 ||
        password.length > 128
      ) {
        return res.status(400).json({
          success: false,
          message: "Проверьте данные. Пароль должен содержать от 8 до 128 символов."
        });
      }

      const normalizedEmail = email.trim().toLowerCase();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          message: "Введите корректный email."
        });
      }

      const existing = db.prepare(
        "SELECT id FROM buyers WHERE email = ?"
      ).get(normalizedEmail);

      if (existing) {
        return res.status(409).json({
          success: false,
          message: "Покупатель с такой почтой уже зарегистрирован."
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const created = db.prepare(`
        INSERT INTO buyers (name, email, phone, password_hash)
        VALUES (?, ?, ?, ?)
      `).run(
        name.trim(),
        normalizedEmail,
        phone.trim(),
        passwordHash
      );

      req.session.regenerate(error => {
        if (error) return res.status(500).json({success:false,message:"Аккаунт создан. Войдите в него."});
        req.session.buyerId = String(created.lastInsertRowid);
        req.session.save(error => error ? res.status(500).json({success:false,message:"Аккаунт создан. Войдите в него."}) : res.status(201).json({success:true,message:"Регистрация покупателя прошла успешно!"}));
      });

    } catch (error) {
      console.error("Ошибка регистрации покупателя:", error);

      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({
          success: false,
          message: "Эта почта уже зарегистрирована."
        });
      }

      return res.status(500).json({
        success: false,
        message: "Ошибка сервера."
      });
    }
  });

  // ВХОД ПОКУПАТЕЛЯ
  app.post("/api/buyer/login", buyerLoginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};

      if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        !email.trim() ||
        !password ||
        email.length > 254 ||
        password.length > 128
      ) {
        return res.status(400).json({
          success: false,
          message: "Введите email и пароль."
        });
      }

      const buyer = db.prepare(
        "SELECT id, name, email, password_hash FROM buyers WHERE email = ?"
      ).get(email.trim().toLowerCase());

      if (!buyer || !(await bcrypt.compare(password, buyer.password_hash))) {
        return res.status(401).json({
          success: false,
          message: "Неверная почта или пароль."
        });
      }

      req.session.regenerate(error => {
        if (error) {
          return res.status(500).json({
            success: false,
            message: "Ошибка создания сессии."
          });
        }

        req.session.buyerId = String(buyer.id);

        req.session.save(error => {
          if (error) {
            return res.status(500).json({
              success: false,
              message: "Ошибка сохранения сессии."
            });
          }

          return res.json({
            success: true,
            message: "Вход выполнен успешно!",
            buyer: {
              id: buyer.id,
              name: buyer.name,
              email: buyer.email
            }
          });
        });
      });

    } catch (error) {
      console.error("Ошибка входа покупателя:", error);

      return res.status(500).json({
        success: false,
        message: "Ошибка сервера."
      });
    }
  });

}

module.exports = registerBuyerRoutes;
