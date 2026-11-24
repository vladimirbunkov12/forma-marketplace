"use strict";

const rateLimit = require("express-rate-limit");

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: "Слишком много попыток оформления заказа. Попробуйте позже через 15 минут."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = function registerBuyerCheckoutRoutes(app, db) {
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
  // Оформление заказа из корзины: создаёт отдельные заказы для каждого продавца
  app.post("/api/buyer/checkout", checkoutLimiter, requireBuyer, (req, res) => {
    try {
      const buyer = db.prepare("SELECT name, phone, delivery_address FROM buyers WHERE id = ?").get(req.session.buyerId);
      const city = typeof req.body?.deliveryCity === "string" ? req.body.deliveryCity.trim() : "";
      const address = typeof req.body?.deliveryAddress === "string" ? req.body.deliveryAddress.trim() : "";
      if (!buyer || buyer.name.trim().length < 2 || buyer.phone.replace(/\D/g, "").length < 7 || buyer.phone.replace(/\D/g, "").length > 15 || city.length < 2 || city.length > 100 || address.length < 5 || address.length > 300) return res.status(400).json({success:false,message:"Проверьте имя, телефон, город и адрес доставки."});
      const cartItems = db.prepare(`
        SELECT
          buyer_cart.id AS cart_item_id,
          buyer_cart.quantity,
          buyer_cart.dimensions,
          products.id AS product_id,
          products.name,
          products.category,
          products.price,
          products.company_id,
          COALESCE(seller_prices.kitchen_per_meter, 0) AS kitchen_per_meter,
          COALESCE(seller_prices.wardrobe_per_sqm, 0) AS wardrobe_per_sqm
        FROM buyer_cart
        JOIN products ON products.id = buyer_cart.product_id
        LEFT JOIN seller_prices ON seller_prices.company_id = products.company_id
        WHERE buyer_cart.buyer_id = ?
      `).all(req.session.buyerId);

      if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Корзина пуста."
        });
      }

      // Группируем товары по продавцу
      const bySeller = new Map();
      for (const item of cartItems) {
        if (!bySeller.has(item.company_id)) {
          bySeller.set(item.company_id, {
            company_id: item.company_id,
            items: []
          });
        }
        bySeller.get(item.company_id).items.push(item);
      }

      // Проверяем каждый товар и компанию продавца
      for (const [companyId, sellerData] of bySeller) {
        const company = db.prepare(`SELECT is_blocked FROM companies WHERE id = ?`).get(companyId);
        if (!company) {
          return res.status(404).json({
            success: false,
            message: "Компания продавца не найдена."
          });
        }
        if (company.is_blocked === 1) {
          return res.status(403).json({
            success: false,
            message: "Заказы временно недоступны: компания продавца заблокирована."
          });
        }
      }

      const createdOrders = [];

      const createAllOrders = db.transaction(() => {
        for (const [companyId, sellerData] of bySeller) {
          const sellerCommission = db.prepare(`
            SELECT commission_rate_bps
            FROM companies
            WHERE id = ?
          `).get(companyId);

          if (!sellerCommission) {
            throw new Error("Компания продавца не найдена.");
          }

          const commissionRateBps = Number(sellerCommission.commission_rate_bps);

          if (
            !Number.isSafeInteger(commissionRateBps) ||
            commissionRateBps < 0 ||
            commissionRateBps > 1500
          ) {
            throw new Error("Некорректная ставка комиссии FORMA.");
          }

          let sellerTotal = 0;
          const orderItemsToInsert = [];

          for (const item of sellerData.items) {
            const category = String(item.category || "").toLowerCase();
            let unitPrice = Number(item.price);
            let savedDimensions = null;

            // Расчёт кухни
            if (category.includes("кух") && Number(item.kitchen_per_meter) > 0) {
              const dims = item.dimensions ? JSON.parse(item.dimensions) : null;
              const length = dims && Number.isFinite(dims.length) ? dims.length : 3;
              if (length < 0.5 || length > 30) {
                throw new Error("Некорректная длина кухни для товара: " + item.name);
              }
              unitPrice = Math.round(length * Number(item.kitchen_per_meter));
              savedDimensions = JSON.stringify({ type: "kitchen", length, unit: "meter" });
            }

            // Расчёт шкафа
            if (category.includes("шкаф") && Number(item.wardrobe_per_sqm) > 0) {
              const dims = item.dimensions ? JSON.parse(item.dimensions) : null;
              const width = dims && Number.isFinite(dims.width) ? dims.width : 2;
              const height = dims && Number.isFinite(dims.height) ? dims.height : 2.4;
              if (width < 0.1 || width > 20 || height < 0.1 || height > 10) {
                throw new Error("Некорректные размеры шкафа для товара: " + item.name);
              }
              const area = width * height;
              unitPrice = Math.round(area * Number(item.wardrobe_per_sqm));
              savedDimensions = JSON.stringify({ type: "wardrobe", width, height, area: Math.round(area * 100) / 100, unit: "sqm" });
            }

            const itemTotal = unitPrice * Number(item.quantity);
            sellerTotal += itemTotal;

            orderItemsToInsert.push({
              product_id: item.product_id,
              quantity: Number(item.quantity),
              unit_price: unitPrice,
              dimensions: savedDimensions
            });
          }

          if (!Number.isSafeInteger(sellerTotal) || sellerTotal <= 0) {
            throw new Error("Некорректная стоимость заказа.");
          }

          const commissionAmount = Number(
            (BigInt(sellerTotal) * BigInt(commissionRateBps) + 5000n) / 10000n
          );
          const sellerAmount = sellerTotal - commissionAmount;

          const sellerDeliverySettings = db.prepare(`
            SELECT payment_by
            FROM seller_delivery_settings
            WHERE company_id = ?
          `).get(companyId);
          const paymentBy = sellerDeliverySettings?.payment_by === "buyer" ? "buyer" : "seller";

          const order = db.prepare(`
            INSERT INTO orders (
              company_id, buyer_name, buyer_phone, delivery_country,
              delivery_city, delivery_address, comment, total_amount,
              commission_rate_bps, commission_amount, seller_amount,
              buyer_id, status
            )
            VALUES (?, ?, ?, 'Kazakhstan', ?, ?, '', ?, ?, ?, ?, ?, 'new')
          `).run(
            companyId,
            buyer.name,
            buyer.phone,
            city,
            address,
            sellerTotal,
            commissionRateBps,
            commissionAmount,
            sellerAmount,
            req.session.buyerId
          );

          const orderId = Number(order.lastInsertRowid);

          for (const oi of orderItemsToInsert) {
            db.prepare(`
              INSERT INTO order_items (order_id, product_id, quantity, unit_price, dimensions)
              VALUES (?, ?, ?, ?, ?)
            `).run(orderId, oi.product_id, oi.quantity, oi.unit_price, oi.dimensions);
          }

          db.prepare(`
            INSERT INTO deliveries (order_id, delivery_mode, delivery_provider, payment_by, country, delivery_status)
            VALUES (?, 'automatic', 'yandex', ?, 'Kazakhstan', 'not_requested')
          `).run(orderId, paymentBy);

          createdOrders.push({
            orderId,
            companyId,
            totalAmount: sellerTotal,
            commissionRateBps,
            commissionAmount,
            sellerAmount,
            paymentBy,
            itemCount: sellerData.items.length
          });
        }

        // Очищаем корзину после успешного создания всех заказов
        db.prepare(`DELETE FROM buyer_cart WHERE buyer_id = ?`).run(req.session.buyerId);
      });

      createAllOrders();

      console.log("FORMA: создано заказов из корзины: " + createdOrders.length);

      return res.json({
        success: true,
        message: "Заказы успешно оформлены!",
        orders: createdOrders
      });

    } catch (error) {
      console.error("Ошибка оформления заказа из корзины:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось оформить заказ. Проверьте параметры корзины."
      });
    }
  });
};
