"use strict";

module.exports = function registerBuyerCartRoutes(app, db) {
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
  // Получить содержимое корзины покупателя с данными товаров
  app.get("/api/buyer/cart", requireBuyer, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT
          buyer_cart.id AS cart_item_id,
          buyer_cart.quantity,
          buyer_cart.dimensions,
          buyer_cart.created_at,
          buyer_cart.updated_at,
          products.id AS product_id,
          products.name,
          products.category,
          products.price,
          products.photo,
          products.weight_kg,
          products.length_cm,
          products.width_cm,
          products.height_cm,
          companies.id AS company_id,
          companies.company_name,
          companies.city,
          companies.phone AS company_phone,
          COALESCE(seller_prices.kitchen_per_meter, 0) AS kitchen_per_meter,
          COALESCE(seller_prices.wardrobe_per_sqm, 0) AS wardrobe_per_sqm
        FROM buyer_cart
        JOIN products ON products.id = buyer_cart.product_id
        JOIN companies ON companies.id = products.company_id
        LEFT JOIN seller_prices ON seller_prices.company_id = companies.id
        WHERE buyer_cart.buyer_id = ?
        ORDER BY buyer_cart.created_at DESC
      `).all(req.session.buyerId);

      const itemsWithUrls = items.map(item => ({
        ...item,
        photoUrl: item.photo ? "/uploads/" + item.photo : null
      }));

      return res.json({
        success: true,
        items: itemsWithUrls
      });
    } catch (error) {
      console.error("Ошибка загрузки корзины:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить корзину."
      });
    }
  });

  // Количество товаров в корзине (для счётчика в шапке)
  app.get("/api/buyer/cart/count", requireBuyer, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM buyer_cart
        WHERE buyer_id = ?
      `).get(req.session.buyerId);

      return res.json({
        success: true,
        count: Number(row.total)
      });
    } catch (error) {
      console.error("Ошибка получения количества в корзине:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось получить количество товаров в корзине."
      });
    }
  });

  // Добавить товар в корзину или обновить количество, если уже есть
  app.post("/api/buyer/cart", requireBuyer, (req, res) => {
    try {
      const { productId, quantity, dimensions } = req.body || {};

      const productIdNum = Number(productId);
      const qty = Number(quantity);

      if (
        !Number.isSafeInteger(productIdNum) || productIdNum <= 0 ||
        !Number.isSafeInteger(qty) || qty < 1 || qty > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Некорректные данные товара."
        });
      }

      const product = db.prepare(
        "SELECT id FROM products WHERE id = ?"
      ).get(productIdNum);

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Товар не найден."
        });
      }

      const dimsJson = dimensions && typeof dimensions === "object"
        ? JSON.stringify(dimensions)
        : null;

      const upsert = db.transaction(() => {
        const existing = db.prepare(`
          SELECT id, quantity FROM buyer_cart
          WHERE buyer_id = ? AND product_id = ?
        `).get(req.session.buyerId, productIdNum);

        if (existing) {
          const newQty = Math.min(100, Number(existing.quantity) + qty);
          db.prepare(`
            UPDATE buyer_cart
            SET quantity = ?, dimensions = COALESCE(?, dimensions), updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(newQty, dimsJson, existing.id);
          return { cartItemId: existing.id, quantity: newQty, updated: true };
        }

        const result = db.prepare(`
          INSERT INTO buyer_cart (buyer_id, product_id, quantity, dimensions)
          VALUES (?, ?, ?, ?)
        `).run(req.session.buyerId, productIdNum, qty, dimsJson);

        return { cartItemId: Number(result.lastInsertRowid), quantity: qty, updated: false };
      });

      const cartResult = upsert();

      return res.status(201).json({
        success: true,
        message: "Товар добавлен в корзину.",
        cartItemId: cartResult.cartItemId,
        quantity: cartResult.quantity,
        updated: cartResult.updated
      });
    } catch (error) {
      console.error("Ошибка добавления в корзину:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось добавить товар в корзину."
      });
    }
  });

  // Обновить количество и/или размеры товара в корзине
  app.patch("/api/buyer/cart/:itemId", requireBuyer, (req, res) => {
    try {
      const itemId = Number(req.params.itemId);
      const { quantity, dimensions } = req.body || {};

      if (!Number.isSafeInteger(itemId) || itemId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Некорректный ID товара в корзине."
        });
      }

      const updates = [];
      const values = [];

      if (quantity !== undefined) {
        const qty = Number(quantity);
        if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) {
          return res.status(400).json({
            success: false,
            message: "Количество должно быть от 1 до 100."
          });
        }
        updates.push("quantity = ?");
        values.push(qty);
      }

      if (dimensions !== null && dimensions !== undefined) {
        const dimsJson = dimensions && typeof dimensions === "object"
          ? JSON.stringify(dimensions)
          : null;
        updates.push("dimensions = ?");
        values.push(dimsJson);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Нет данных для обновления."
        });
      }

      updates.push("updated_at = CURRENT_TIMESTAMP");
      values.push(itemId, req.session.buyerId);

      const result = db.prepare(`
        UPDATE buyer_cart
        SET ${updates.join(", ")}
        WHERE id = ? AND buyer_id = ?
      `).run(...values);

      if (result.changes === 0) {
        return res.status(404).json({
          success: false,
          message: "Товар в корзине не найден."
        });
      }

      return res.json({
        success: true,
        message: "Корзина обновлена."
      });
    } catch (error) {
      console.error("Ошибка обновления корзины:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось обновить корзину."
      });
    }
  });

  // Удалить товар из корзины
  app.delete("/api/buyer/cart/:itemId", requireBuyer, (req, res) => {
    try {
      const itemId = Number(req.params.itemId);

      if (!Number.isSafeInteger(itemId) || itemId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Некорректный ID товара в корзине."
        });
      }

      const result = db.prepare(`
        DELETE FROM buyer_cart
        WHERE id = ? AND buyer_id = ?
      `).run(itemId, req.session.buyerId);

      if (result.changes === 0) {
        return res.status(404).json({
          success: false,
          message: "Товар в корзине не найден."
        });
      }

      return res.json({
        success: true,
        message: "Товар удалён из корзины."
      });
    } catch (error) {
      console.error("Ошибка удаления из корзины:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось удалить товар из корзины."
      });
    }
  });

  // Очистить корзину полностью
  app.delete("/api/buyer/cart", requireBuyer, (req, res) => {
    try {
      db.prepare(`
        DELETE FROM buyer_cart
        WHERE buyer_id = ?
      `).run(req.session.buyerId);

      return res.json({
        success: true,
        message: "Корзина очищена."
      });
    } catch (error) {
      console.error("Ошибка очистки корзины:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось очистить корзину."
      });
    }
  });
};
