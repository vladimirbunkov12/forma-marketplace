"use strict";

function registerBuyerOrderRoutes(app, db) {
  app.get("/api/buyer/orders", (req, res) => {
    try {
      const buyerId = req.session && req.session.buyerId;

      if (!buyerId) {
        return res.status(401).json({
          success: false,
          message: "Необходимо войти в аккаунт покупателя."
        });
      }

      const buyer = db.prepare(
        "SELECT id FROM buyers WHERE id = ?"
      ).get(buyerId);

      if (!buyer) {
        return res.status(401).json({
          success: false,
          message: "Аккаунт покупателя не найден."
        });
      }

      const orders = db.prepare(`
        SELECT
          id,
          company_id,
          total_amount,
          status,
          payment_status,
          delivery_city,
          delivery_address,
          created_at
        FROM orders
        WHERE buyer_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `).all(buyerId);

      return res.json({
        success: true,
        orders
      });

    } catch (error) {
      console.error("Ошибка истории заказов:", error);

      return res.status(500).json({
        success: false,
        message: "Ошибка получения заказов."
      });
    }
  });
}

module.exports = registerBuyerOrderRoutes;
