"use strict";
const pool = require("./postgres");

function registerBuyerOrderRoutes(app, db) {
  app.get("/api/buyer/orders", async (req, res) => {
    try {
      const buyerId = req.session && req.session.buyerId;

      if (!buyerId) {
        return res.status(401).json({
          success: false,
          message: "Необходимо войти в аккаунт покупателя."
        });
      }

      const buyer = (await pool.query("SELECT id FROM buyers WHERE id = $1", [buyerId])).rows[0];

      if (!buyer) {
        return res.status(401).json({
          success: false,
          message: "Аккаунт покупателя не найден."
        });
      }

      const orders = (await pool.query(`
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
        WHERE buyer_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `, [buyerId])).rows;

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
