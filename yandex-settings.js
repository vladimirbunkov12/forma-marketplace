
const { encrypt, decrypt } = require("./yandex-crypto");

module.exports = function registerYandexSettings(app, db, requireLogin) {

  // Получение настроек текущего магазина
  app.get("/api/yandex-settings", requireLogin, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT
          yandex_api_key_encrypted,
          pickup_city,
          pickup_address,
          payment_by
        FROM seller_delivery_settings
        WHERE company_id = ?
      `).get(req.session.companyId);

      return res.json({
        success: true,
        connected: Boolean(row?.yandex_api_key_encrypted),
        pickupCity: row?.pickup_city || "",
        pickupAddress: row?.pickup_address || "",
        payment_by: row?.payment_by === "buyer" ? "buyer" : "seller"
      });

    } catch (error) {
      console.error("Ошибка настроек доставки:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось получить настройки доставки"
      });
    }
  });

  // Сохранение API-ключа
  app.post("/api/yandex-settings", requireLogin, (req, res) => {
    try {
      const paymentBy = req.body?.payment_by;

      if (paymentBy !== undefined) {
        if (paymentBy !== "seller" && paymentBy !== "buyer") {
          return res.status(400).json({
            success: false,
            message: "Выберите допустимого плательщика доставки"
          });
        }

        db.prepare(`
          INSERT INTO seller_delivery_settings (
            company_id,
            payment_by,
            updated_at
          )
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(company_id)
          DO UPDATE SET
            payment_by = excluded.payment_by,
            updated_at = CURRENT_TIMESTAMP
        `).run(req.session.companyId, paymentBy);

        return res.json({
          success: true,
          payment_by: paymentBy,
          message: "Настройка плательщика сохранена"
        });
      }

      const apiKey = req.body?.apiKey;

      if (
        typeof apiKey !== "string" ||
        apiKey.length < 10 ||
        apiKey.length > 2000
      ) {
        return res.status(400).json({
          success: false,
          message: "Введите корректный API-ключ"
        });
      }

      const encryptedKey = encrypt(apiKey);

      db.prepare(`
        INSERT INTO seller_delivery_settings (
          company_id,
          yandex_api_key_encrypted,
          updated_at
        )
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(company_id)
        DO UPDATE SET
          yandex_api_key_encrypted = excluded.yandex_api_key_encrypted,
          updated_at = CURRENT_TIMESTAMP
      `).run(req.session.companyId, encryptedKey);

      return res.json({
        success: true,
        message: "API-ключ сохранён"
      });

    } catch (error) {
      console.error("Ошибка сохранения API-ключа:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось сохранить API-ключ"
      });
    }
  });

  // Сохранение адреса отправления магазина
  app.post("/api/yandex-settings/pickup", requireLogin, (req, res) => {
    try {
      const city = String(req.body?.pickupCity || "").trim();
      const address = String(req.body?.pickupAddress || "").trim();

      if (
        city.length < 2 || city.length > 100 ||
        address.length < 5 || address.length > 300
      ) {
        return res.status(400).json({
          success: false,
          message: "Проверьте город и адрес склада"
        });
      }

      db.prepare(`
        INSERT INTO seller_delivery_settings (
          company_id,
          pickup_city,
          pickup_address,
          updated_at
        )
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(company_id)
        DO UPDATE SET
          pickup_city = excluded.pickup_city,
          pickup_address = excluded.pickup_address,
          updated_at = CURRENT_TIMESTAMP
      `).run(req.session.companyId, city, address);

      db.prepare(`
        UPDATE companies
        SET pickup_address = ?
        WHERE id = ?
      `).run(address, req.session.companyId);

      return res.json({
        success: true,
        message: "Адрес склада сохранён"
      });

    } catch (error) {
      console.error("Ошибка сохранения адреса:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось сохранить адрес склада"
      });
    }
  });

  // Сохранение адреса склада текущей компании
  // Отключение доставки текущего магазина
  app.delete("/api/yandex-settings", requireLogin, (req, res) => {
    try {
      db.prepare(`
        UPDATE seller_delivery_settings
        SET
          yandex_api_key_encrypted = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE company_id = ?
      `).run(req.session.companyId);

      return res.json({
        success: true,
        connected: false,
        message: "Яндекс Доставка отключена"
      });

    } catch (error) {
      console.error("Ошибка отключения доставки:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось отключить Яндекс Доставку"
      });
    }
  });

};
