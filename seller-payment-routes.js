module.exports = function registerSellerPaymentRoutes(app, db, requireLogin) {
  // Реквизиты читаются только для компании, идентификатор которой взят из сессии.
  app.get("/api/seller/payment-details", requireLogin, (req, res) => {
    try {
      const details = db.prepare(`
        SELECT business_type, business_identifier, bank_name, iban,
               is_demo, updated_at
        FROM seller_payment_details
        WHERE company_id = ?
      `).get(req.session.companyId);

      return res.json({
        success: true,
        paymentDetails: details || null
      });
    } catch (error) {
      console.error("Ошибка загрузки платёжных реквизитов продавца:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить платёжные реквизиты."
      });
    }
  });

  // Создать или изменить только собственные реквизиты продавца.
  app.put("/api/seller/payment-details", requireLogin, (req, res) => {
    const businessType = req.body?.business_type;
    const identifier = String(req.body?.business_identifier || "").trim();
    const bankName = String(req.body?.bank_name || "").trim();
    const iban = String(req.body?.iban || "")
      .replace(/\s+/g, "")
      .toUpperCase();
    const isDemo = req.body?.is_demo === true;

    if (isDemo && process.env.NODE_ENV === "production") {
      return res.status(403).json({
        success: false,
        message: "Демонстрационные реквизиты недоступны в production."
      });
    }

    const isExactDemoRecord = businessType === "ip" &&
      identifier === "000000000000" &&
      bankName === "DEMO ONLY - NOT A BANK" &&
      iban === "KZ000000000000000000";

    if (isDemo && !isExactDemoRecord) {
      return res.status(400).json({
        success: false,
        message: "Можно сохранить только фиксированный набор тестовых реквизитов."
      });
    }

    if (!['ip', 'too'].includes(businessType)) {
      return res.status(400).json({
        success: false,
        message: "Выберите форму бизнеса: ИП или ТОО."
      });
    }

    if (!/^\d{12}$/.test(identifier)) {
      return res.status(400).json({
        success: false,
        message: businessType === "ip"
          ? "ИИН должен содержать ровно 12 цифр."
          : "БИН должен содержать ровно 12 цифр."
      });
    }

    if (bankName.length < 2 || bankName.length > 120 ||
        /[<>\u0000-\u001f]/.test(bankName)) {
      return res.status(400).json({
        success: false,
        message: "Укажите корректное название банка (2–120 символов)."
      });
    }

    // Казахстанский IBAN: префикс KZ и 18 цифр.
    if (!/^KZ\d{18}$/.test(iban)) {
      return res.status(400).json({
        success: false,
        message: "IBAN должен иметь формат KZ и далее 18 цифр."
      });
    }

    if (!isDemo && (identifier === "000000000000" ||
      iban === "KZ000000000000000000" ||
      bankName.toUpperCase().startsWith("DEMO"))) {
      return res.status(400).json({
        success: false,
        message: "Демо-значения нельзя сохранять как настоящие реквизиты."
      });
    }

    try {
      db.prepare(`
        INSERT INTO seller_payment_details (
          company_id,
          business_type,
          business_identifier,
          bank_name,
          iban,
          is_demo,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(company_id)
        DO UPDATE SET
          business_type = excluded.business_type,
          business_identifier = excluded.business_identifier,
          bank_name = excluded.bank_name,
          iban = excluded.iban,
          is_demo = excluded.is_demo,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        req.session.companyId,
        businessType,
        identifier,
        bankName,
        iban,
        isDemo ? 1 : 0
      );

      return res.json({
        success: true,
        message: "Платёжные реквизиты сохранены.",
        paymentDetails: {
          business_type: businessType,
          business_identifier: identifier,
          bank_name: bankName,
          iban,
          is_demo: isDemo
        }
      });
    } catch (error) {
      console.error("Ошибка сохранения платёжных реквизитов продавца:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось сохранить платёжные реквизиты."
      });
    }
  });

  // Демонстрационная отметка: никогда не является подтверждением реальной оплаты.
  app.post("/api/orders/:id/demo-payment", requireLogin, (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({
        success: false,
        message: "Демонстрационная оплата недоступна в production."
      });
    }

    const orderId = Number(req.params.id);

    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).json({
        success: false,
        message: "Некорректный номер заказа."
      });
    }

    try {
      const result = db.prepare(`
        UPDATE orders
        SET payment_status = 'paid_test',
            payment_test_marked_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND company_id = ?
          AND payment_status = 'awaiting_payment'
      `).run(orderId, req.session.companyId);

      if (result.changes !== 1) {
        const ownedOrder = db.prepare(`
          SELECT payment_status
          FROM orders
          WHERE id = ? AND company_id = ?
        `).get(orderId, req.session.companyId);

        if (!ownedOrder) {
          return res.status(404).json({
            success: false,
            message: "Заказ не найден."
          });
        }

        return res.status(409).json({
          success: false,
          message: "Демо-статус оплаты уже установлен или недоступен."
        });
      }

      return res.json({
        success: true,
        paymentStatus: "paid_test",
        message: "Установлен только демонстрационный статус «Оплачен (тест)». Реальная оплата не подтверждена."
      });
    } catch (error) {
      console.error("Ошибка установки тестового статуса оплаты:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось установить демонстрационный статус оплаты."
      });
    }
  });
};
