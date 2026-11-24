"use strict";

function registerBuyerProfileRoutes(app, db) {

  function requireBuyer(req, res, next) {
    if (!req.session || !req.session.buyerId) {
      return res.status(401).json({
        success: false,
        message: "Необходимо войти в аккаунт покупателя."
      });
    }

    const buyer = db.prepare(
      "SELECT id FROM buyers WHERE id = ?"
    ).get(req.session.buyerId);

    if (!buyer) {
      return res.status(401).json({
        success: false,
        message: "Аккаунт покупателя не найден."
      });
    }

    next();
  }

  app.get("/api/buyer/me", requireBuyer, (req, res) => {
    const buyer = db.prepare(`
      SELECT id, name, email, phone, delivery_address, created_at
      FROM buyers
      WHERE id = ?
    `).get(req.session.buyerId);

    res.json({
      success: true,
      buyer
    });
  });

  // Сохранение адреса доставки покупателя
  app.patch("/api/buyer/address", requireBuyer, (req, res) => {
    try {
      const address = req.body?.delivery_address;

      if (
        typeof address !== "string" ||
        address.trim().length < 5 ||
        address.trim().length > 300
      ) {
        return res.status(400).json({
          success: false,
          message: "Укажите адрес доставки от 5 до 300 символов."
        });
      }

      const cleanAddress = address.trim();

      db.prepare(`
        UPDATE buyers
        SET delivery_address = ?
        WHERE id = ?
      `).run(cleanAddress, req.session.buyerId);

      return res.json({
        success: true,
        message: "Адрес доставки сохранён.",
        delivery_address: cleanAddress
      });

    } catch (error) {
      console.error("Ошибка сохранения адреса:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось сохранить адрес доставки."
      });
    }
  });

}

module.exports = registerBuyerProfileRoutes;
