const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { createRequireAdmin } = require("./admin-auth");

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Слишком много попыток входа администратора. Попробуйте позже через 15 минут."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = function registerAdminRoutes(app, db) {
  const requireAdmin = createRequireAdmin(db);

  // Вход владельца
  app.post("/api/admin/login", adminLoginLimiter, async (req, res) => {
    try {
      const email = String(req.body?.email || "")
        .trim().toLowerCase();
      const password = req.body?.password;

      if (
        !email ||
        typeof password !== "string" ||
        !password
      ) {
        return res.status(400).json({
          success: false,
          message: "Проверьте данные входа."
        });
      }

      const admin = db.prepare(
        "SELECT * FROM admin_users WHERE email = ?"
      ).get(email);

      if (!admin || !(await bcrypt.compare(
        password,
        admin.password_hash
      ))) {
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

        req.session.adminId = admin.id;

        req.session.save(error => {
          if (error) {
            return res.status(500).json({
              success: false,
              message: "Ошибка сохранения сессии."
            });
          }

          res.json({
            success: true,
            message: "Вход владельца выполнен."
          });
        });
      });

    } catch (error) {
      console.error("Ошибка входа администратора:", error);
      res.status(500).json({
        success: false,
        message: "Ошибка сервера."
      });
    }
  });

  // Проверка авторизации владельца
  app.get("/api/admin/me", requireAdmin, (req, res) => {
    res.json({
      success: true,
      admin: {
        id: req.session.adminId,
        email: db.prepare("SELECT email FROM admin_users WHERE id = ?").get(req.session.adminId).email
      }
    });
  });

  // Выход владельца
  app.post("/api/admin/logout", requireAdmin, (req, res) => {
    req.session.destroy(error => {
      if (error) {
        return res.status(500).json({
          success: false,
          message: "Ошибка выхода."
        });
      }

      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });

  // Список продавцов
  app.get("/api/admin/companies", requireAdmin, (req, res) => {
    const companies = db.prepare(`
      SELECT id, company_name, city, phone,
             email, is_blocked, created_at, commission_rate_bps
      FROM companies
      ORDER BY id DESC
    `).all();

    res.json({ success: true, companies });
  });

  // История предложений изменения комиссии
  app.get("/api/admin/commission-proposals", requireAdmin, (req, res) => {
    try {
      const proposals = db.prepare(`
        SELECT
          proposals.id,
          proposals.company_id,
          companies.company_name,
          companies.city,
          proposals.old_rate_bps,
          proposals.new_rate_bps,
          proposals.status,
          proposals.created_at,
          proposals.decided_at
        FROM commission_change_proposals AS proposals
        LEFT JOIN companies ON companies.id = proposals.company_id
        ORDER BY proposals.id DESC
        LIMIT 200
      `).all();

      return res.json({ success: true, proposals });
    } catch (error) {
      console.error("Ошибка загрузки предложений комиссии:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить историю предложений."
      });
    }
  });

  // Создать предложение новой ставки конкретной компании
  app.post("/api/admin/commission-proposals", requireAdmin, (req, res) => {
    const companyId = Number(req.body?.companyId);
    const newRateBps = Number(req.body?.newRateBps);

    if (
      !Number.isSafeInteger(companyId) || companyId < 1 ||
      !Number.isSafeInteger(newRateBps) ||
      newRateBps < 500 || newRateBps > 1500
    ) {
      return res.status(400).json({
        success: false,
        message: "Выберите компанию и ставку от 5% до 15%."
      });
    }

    try {
      const createProposal = db.transaction(() => {
        const company = db.prepare(`
          SELECT id, commission_rate_bps
          FROM companies
          WHERE id = ?
        `).get(companyId);

        if (!company) return { kind: "not_found" };

        const oldRateBps = Number(company.commission_rate_bps);
        if (oldRateBps === newRateBps) return { kind: "unchanged" };

        db.prepare(`
          UPDATE commission_change_proposals
          SET status = 'cancelled', decided_at = CURRENT_TIMESTAMP
          WHERE company_id = ? AND status = 'pending'
        `).run(companyId);

        const result = db.prepare(`
          INSERT INTO commission_change_proposals (
            company_id,
            old_rate_bps,
            new_rate_bps,
            status
          )
          VALUES (?, ?, ?, 'pending')
        `).run(companyId, oldRateBps, newRateBps);

        return {
          kind: "created",
          proposalId: Number(result.lastInsertRowid),
          oldRateBps,
          newRateBps
        };
      });

      const result = createProposal();
      if (result.kind === "not_found") {
        return res.status(404).json({
          success: false,
          message: "Компания не найдена."
        });
      }
      if (result.kind === "unchanged") {
        return res.status(409).json({
          success: false,
          message: "Новая ставка совпадает с текущей."
        });
      }

      return res.status(201).json({
        success: true,
        proposalId: result.proposalId,
        oldRateBps: result.oldRateBps,
        newRateBps: result.newRateBps,
        status: "pending"
      });
    } catch (error) {
      console.error("Ошибка создания предложения комиссии:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось создать предложение комиссии."
      });
    }
  });

  // Блокировка и разблокировка продавца
  app.patch(
    "/api/admin/companies/:id/block",
    requireAdmin,
    (req, res) => {
      const id = Number(req.params.id);
      const blocked = req.body?.blocked;

      if (!Number.isSafeInteger(id) || id < 1 ||
          typeof blocked !== "boolean") {
        return res.status(400).json({
          success: false,
          message: "Некорректные данные."
        });
      }

      const result = db.prepare(`
        UPDATE companies
        SET is_blocked = ?
        WHERE id = ?
      `).run(blocked ? 1 : 0, id);

      if (!result.changes) {
        return res.status(404).json({
          success: false,
          message: "Продавец не найден."
        });
      }

      res.json({
        success: true,
        message: blocked
          ? "Продавец заблокирован."
          : "Продавец разблокирован."
      });
    }
  );

  // Все заказы
  app.get("/api/admin/orders", requireAdmin, (req, res) => {
    const orders = db.prepare(`
      SELECT
        orders.*,
        companies.company_name
      FROM orders
      LEFT JOIN companies
        ON companies.id = orders.company_id
      ORDER BY orders.id DESC
      LIMIT 500
    `).all();

    res.json({ success: true, orders });
  });

  // Глобальная финансовая статистика доступна только владельцу.
  app.get("/api/admin/finance", requireAdmin, (req, res) => {
    try {
      const requestedPage = req.query?.page === undefined
        ? 1
        : Number(req.query.page);

      if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
        return res.status(400).json({
          success: false,
          message: "Некорректный номер страницы."
        });
      }

      const pageSize = 25;
      const summary = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM companies) AS company_count,
          COUNT(*) AS order_count,
          COALESCE(SUM(
            CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END
          ), 0) AS sales_total,
          COALESCE(SUM(
            CASE WHEN COALESCE(commission_rate_bps, 0) > 0
              AND payment_status = 'paid'
              THEN COALESCE(commission_amount, 0)
              ELSE 0
            END
          ), 0) AS confirmed_commission_total,
          COALESCE(SUM(
            CASE WHEN COALESCE(commission_rate_bps, 0) > 0
              AND payment_status = 'paid'
              THEN COALESCE(seller_amount, 0)
              ELSE 0
            END
          ), 0) AS seller_amount_total,
          COALESCE(SUM(
            CASE WHEN COALESCE(commission_rate_bps, 0) > 0
              AND payment_status = 'paid'
              THEN 1
              ELSE 0
            END
          ), 0) AS confirmed_order_count,
          COALESCE(SUM(
            CASE WHEN COALESCE(commission_rate_bps, 0) = 0
              AND payment_status = 'paid'
              THEN 1
              ELSE 0
            END
          ), 0) AS clarification_order_count
        FROM orders
      `).get();

      const totalPages = Math.max(
        1,
        Math.ceil(summary.order_count / pageSize)
      );
      const page = Math.min(requestedPage, totalPages);
      const offset = (page - 1) * pageSize;

      const companies = db.prepare(`
        WITH company_sales AS (
          SELECT company_id, SUM(total_amount) AS sales_total
          FROM orders
          GROUP BY company_id
        )
        SELECT
          companies.id,
          companies.company_name,
          companies.city,
          COALESCE(company_sales.sales_total, 0) AS sales_total
        FROM companies
        LEFT JOIN company_sales
          ON company_sales.company_id = companies.id
        ORDER BY sales_total DESC,
                 companies.company_name COLLATE NOCASE ASC,
                 companies.id ASC
      `).all();

      const orders = db.prepare(`
        SELECT
          orders.id,
          orders.company_id,
          companies.company_name,
          orders.created_at,
          orders.buyer_name,
          orders.total_amount,
          orders.commission_rate_bps,
          CASE WHEN COALESCE(orders.commission_rate_bps, 0) > 0
            THEN orders.commission_amount
            ELSE NULL
          END AS commission_amount,
          CASE WHEN COALESCE(orders.commission_rate_bps, 0) > 0
            THEN orders.seller_amount
            ELSE NULL
          END AS seller_amount,
          CASE WHEN COALESCE(orders.commission_rate_bps, 0) > 0
            THEN 'Подтверждено'
            ELSE 'Требует уточнения'
          END AS financial_status
        FROM orders
        LEFT JOIN companies
          ON companies.id = orders.company_id
        ORDER BY orders.id DESC
        LIMIT ? OFFSET ?
      `).all(pageSize, offset);

      return res.json({
        success: true,
        summary: {
          companyCount: summary.company_count,
          orderCount: summary.order_count,
          salesTotal: summary.sales_total,
          confirmedCommissionTotal: summary.confirmed_commission_total,
          sellerAmountTotal: summary.seller_amount_total,
          confirmedOrderCount: summary.confirmed_order_count,
          clarificationOrderCount: summary.clarification_order_count
        },
        companies,
        history: {
          orders,
          page,
          pageSize,
          totalPages,
          totalCount: summary.order_count
        }
      });
    } catch (error) {
      console.error("Ошибка получения финансовой статистики:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить финансовую статистику."
      });
    }
  });

  // Смена пароля администратора
  app.post("/api/admin/change-password", requireAdmin, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};

      if (
        typeof currentPassword !== "string" ||
        typeof newPassword !== "string" ||
        newPassword.length < 12 ||
        newPassword.length > 128
      ) {
        return res.status(400).json({
          success: false,
          message: "Новый пароль должен содержать от 12 до 128 символов."
        });
      }

      const admin = db.prepare(
        "SELECT id, password_hash FROM admin_users WHERE id = ?"
      ).get(req.session.adminId);

      if (!admin || !(await bcrypt.compare(currentPassword, admin.password_hash))) {
        return res.status(401).json({
          success: false,
          message: "Текущий пароль указан неверно."
        });
      }

      if (await bcrypt.compare(newPassword, admin.password_hash)) {
        return res.status(400).json({
          success: false,
          message: "Новый пароль должен отличаться от старого."
        });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);

      db.prepare(
        "UPDATE admin_users SET password_hash = ? WHERE id = ?"
      ).run(passwordHash, admin.id);

      return res.json({
        success: true,
        message: "Пароль успешно изменён."
      });
    } catch (error) {
      console.error("Ошибка смены пароля администратора:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось изменить пароль."
      });
    }
  });

  // Реквизиты платформы FORMA — получить
  app.get("/api/admin/platform-details", requireAdmin, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT company_name, bin_iin, legal_address, phone, email,
               bank_name, bik, iban, updated_at
        FROM platform_payment_details WHERE id = 1
      `).get();

      return res.json({
        success: true,
        details: row || {}
      });
    } catch (error) {
      console.error("Ошибка загрузки реквизитов FORMA:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить реквизиты FORMA."
      });
    }
  });

  // Реквизиты платформы FORMA — сохранить (черновик разрешен, поля не обязательны)
  app.post("/api/admin/platform-details", requireAdmin, (req, res) => {
    try {
      const {
        companyName, binIin, legalAddress, phone, email,
        bankName, bik, iban
      } = req.body || {};

      const errors = [];

      if (binIin !== undefined && binIin !== null && String(binIin).trim() !== "" &&
          !/^\d{12}$/.test(String(binIin).trim())) {
        errors.push("БИН/ИИН должен содержать ровно 12 цифр.");
      }

      if (email !== undefined && email !== null && String(email).trim() !== "" &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
        errors.push("Укажите корректный email.");
      }

      if (bik !== undefined && bik !== null && String(bik).trim() !== "" &&
          !/^\d{7}$/.test(String(bik).trim())) {
        errors.push("БИК должен содержать ровно 7 цифр.");
      }

      if (iban !== undefined && iban !== null && String(iban).trim() !== "" &&
          !/^KZ[A-Z0-9]{18}$/.test(String(iban).trim().toUpperCase())) {
        errors.push("IBAN должен начинаться с KZ и содержать 20 символов.");
      }

      if (errors.length) {
        return res.status(400).json({
          success: false,
          message: errors.join(" ")
        });
      }

      const values = {
        company_name: companyName ? String(companyName).trim() : null,
        bin_iin: binIin ? String(binIin).trim() : null,
        legal_address: legalAddress ? String(legalAddress).trim() : null,
        phone: phone ? String(phone).trim() : null,
        email: email ? String(email).trim() : null,
        bank_name: bankName ? String(bankName).trim() : null,
        bik: bik ? String(bik).trim() : null,
        iban: iban ? String(iban).trim().toUpperCase() : null,
        updated_at: new Date().toISOString()
      };

      const columns = Object.keys(values).join(", ");
      const placeholders = Object.keys(values).map(() => "?").join(", ");

      db.prepare(`
        INSERT INTO platform_payment_details (id, ${columns})
        VALUES (1, ${placeholders})
        ON CONFLICT(id) DO UPDATE SET
          ${Object.keys(values).map(key => key + " = excluded." + key).join(", ")}
      `).run(...Object.values(values));

      return res.json({
        success: true,
        message: "Реквизиты FORMA сохранены."
      });
    } catch (error) {
      console.error("Ошибка сохранения реквизитов FORMA:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось сохранить реквизиты FORMA."
      });
    }
  });

};
