
const { checkYandexDeliveryReady } = require("./yandex-delivery-check");
const rateLimit = require("express-rate-limit");
const { requireSameOriginForMutations } = require("./admin-auth");

// Ограничение частоты создания заказов: 5 запросов за 15 минут с одного IP.
// Применяется только к POST /api/orders. GET /api/orders и остальные маршруты
// не ограничены этим лимитом. IP определяется Express с учётом trust proxy
// (настроен в server.js: доверяются только явно указанные TRUST_PROXY_IPS).
const orderCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Слишком много попыток оформления заказа. Попробуйте позже через 15 минут."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = function registerDeliveryRoutes(app, db, requireLogin) {

  // Оформление заказа покупателем (с защитой от CSRF и ограничением частоты)
  app.post("/api/orders", orderCreateLimiter, requireSameOriginForMutations, async (req, res) => {
    try {
      const {
        productId,
        quantity,
        buyerName,
        buyerPhone,
        deliveryCity,
        deliveryAddress,
        comment,
        dimensions
      } = req.body || {};

      const id = Number(productId);
      const count = Number(quantity);

      const name = String(buyerName || "").trim();
      const phone = String(buyerPhone || "").trim();
      const city = String(deliveryCity || "").trim();
      const address = String(deliveryAddress || "").trim();
      const note = String(comment || "").trim();

      const phoneDigits = phone.replace(/\D/g, "");

      if (
        !Number.isSafeInteger(id) || id <= 0 ||
        !Number.isSafeInteger(count) || count < 1 || count > 100 ||
        name.length < 2 || name.length > 100 ||
        phoneDigits.length < 7 || phoneDigits.length > 15 ||
        city.length < 2 || city.length > 100 ||
        address.length < 5 || address.length > 300 ||
        note.length > 1000
      ) {
        return res.status(400).json({
          success: false,
          message: "Проверьте данные заказа и доставки."
        });
      }

      // Получаем товар и расценки его продавца
      const product = await db.prepare(`
        SELECT
          products.id,
          products.company_id,
          products.name,
          products.category,
          products.price,
          products.weight_kg,
          products.length_cm,
          products.width_cm,
          products.height_cm,
          COALESCE(seller_prices.kitchen_per_meter, 0)
            AS kitchen_per_meter,
          COALESCE(seller_prices.wardrobe_per_sqm, 0)
            AS wardrobe_per_sqm
        FROM products
        LEFT JOIN seller_prices
          ON seller_prices.company_id = products.company_id
        WHERE products.id = ?
      `).get(id);

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Товар не найден."
        });
      }

      // Проверка существования и блокировки компании продавца
      const company = await db.prepare(`SELECT is_blocked FROM companies WHERE id = ?`).get(
        product.company_id
      );

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

      const category = String(product.category || "").toLowerCase();

      let unitPrice = Number(product.price);
      let savedDimensions = null;

      // Расчёт кухни
      if (category.includes("кух") &&
          Number(product.kitchen_per_meter) > 0) {

        const length = Number(dimensions?.length);

        if (!Number.isFinite(length) ||
            length < 0.5 || length > 30) {
          return res.status(400).json({
            success: false,
            message: "Укажите длину кухни от 0,5 до 30 метров."
          });
        }

        unitPrice = Math.round(
          length * Number(product.kitchen_per_meter)
        );

        savedDimensions = JSON.stringify({
          type: "kitchen",
          length: length,
          unit: "meter"
        });
      }

      // Расчёт шкафа
      if (category.includes("шкаф") &&
          Number(product.wardrobe_per_sqm) > 0) {

        const width = Number(dimensions?.width);
        const height = Number(dimensions?.height);

        if (
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width < 0.1 || width > 20 ||
          height < 0.1 || height > 10
        ) {
          return res.status(400).json({
            success: false,
            message: "Укажите корректные размеры шкафа."
          });
        }

        const area = width * height;

        unitPrice = Math.round(
          area * Number(product.wardrobe_per_sqm)
        );

        savedDimensions = JSON.stringify({
          type: "wardrobe",
          width,
          height,
          area: Math.round(area * 100) / 100,
          unit: "sqm"
        });
      }

      const total = unitPrice * count;

      if (
        !Number.isSafeInteger(unitPrice) ||
        !Number.isSafeInteger(total) ||
        unitPrice <= 0 ||
        total <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Некорректная стоимость заказа."
        });
      }

      // Создаём заказ, товар и доставку одной транзакцией
      const createOrder = db.transaction(async () => {
        const sellerCommission = await db.prepare(`
          SELECT commission_rate_bps
          FROM companies
          WHERE id = ?
        `).get(product.company_id);

        if (!sellerCommission) {
          throw new Error("Компания продавца не найдена.");
        }

        const commissionRateBps = Number(
          sellerCommission.commission_rate_bps
        );

        if (
          !Number.isSafeInteger(commissionRateBps) ||
          commissionRateBps < 0 ||
          commissionRateBps > 1500
        ) {
          throw new Error("Некорректная ставка комиссии FORMA.");
        }

        // Округление до целого тенге: ближайшее целое, половина вверх.
        const commissionAmount = Number(
          (BigInt(total) * BigInt(commissionRateBps) + 5000n) / 10000n
        );
        const sellerAmount = total - commissionAmount;

        const sellerDeliverySettings = await db.prepare(`
          SELECT payment_by
          FROM seller_delivery_settings
          WHERE company_id = ?
        `).get(product.company_id);
        const paymentBy = sellerDeliverySettings?.payment_by === "buyer"
          ? "buyer"
          : "seller";

        const order = await db.prepare(`
          INSERT INTO orders (
            company_id,
            buyer_name,
            buyer_phone,
            delivery_country,
            delivery_city,
            delivery_address,
            comment,
            total_amount,
            commission_rate_bps,
            commission_amount,
            seller_amount,
            buyer_id,
            status
          )
          VALUES (?, ?, ?, 'Kazakhstan', ?, ?, ?, ?, ?, ?, ?, ?, 'new')
        `).run(
          product.company_id,
          name,
          phone,
          city,
          address,
          note,
          total,
          commissionRateBps,
          commissionAmount,
          sellerAmount,
          req.session?.buyerId || null
        );

        const orderId = Number(order.lastInsertRowid);

        await db.prepare(`
          INSERT INTO order_items (
            order_id,
            product_id,
            quantity,
            unit_price,
            dimensions
          )
          VALUES (?, ?, ?, ?, ?)
        `).run(
          orderId,
          product.id,
          count,
          unitPrice,
          savedDimensions
        );

        await db.prepare(`
          INSERT INTO deliveries (
            order_id,
            delivery_mode,
            delivery_provider,
            payment_by,
            country,
            delivery_status
          )
          VALUES (?, 'automatic', 'yandex', ?,
                  'Kazakhstan', 'not_requested')
        `).run(orderId, paymentBy);

        return {
          orderId,
          paymentBy,
          commissionRateBps,
          commissionAmount,
          sellerAmount
        };
      });

      const {
        orderId,
        paymentBy,
        commissionRateBps,
        commissionAmount,
        sellerAmount
      } = await createOrder();

      console.log("FORMA: создан заказ №" + orderId);

      return res.status(201).json({
        success: true,
        message: "Заказ успешно оформлен!",
        orderId,
        productName: product.name,
        quantity: count,
        unitPrice,
        totalAmount: total,
        commissionRateBps,
        commissionAmount,
        sellerAmount,
        dimensions: savedDimensions
          ? JSON.parse(savedDimensions)
          : null,
        delivery: {
          provider: "yandex",
          paymentBy,
          status: "not_requested"
        }
      });

    } catch (error) {
      console.error("Ошибка создания заказа:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось оформить заказ."
      });
    }
  });


  // Получение заказов текущего продавца
  app.get("/api/orders", requireLogin, async (req, res) => {
    try {
      const rows = await db.prepare(`
        SELECT
          orders.id,
          orders.buyer_name,
          orders.buyer_phone,
          orders.delivery_city,
          orders.delivery_address,
          orders.comment,
          orders.total_amount,
          orders.payment_status,
          orders.payment_test_marked_at,
          orders.commission_amount,
          orders.seller_amount,
          orders.status,
          orders.created_at,

          order_items.quantity,
          order_items.unit_price,
          order_items.dimensions,

          products.name AS product_name,
          products.weight_kg,
          products.length_cm,
          products.width_cm,
          products.height_cm,

          deliveries.delivery_mode,
          deliveries.payment_by,
          deliveries.delivery_cost,
          deliveries.delivery_status,
          deliveries.is_demo,
          deliveries.provider_order_id,
          deliveries.tracking_url

        FROM orders

        LEFT JOIN order_items
          ON order_items.order_id = orders.id

        LEFT JOIN products
          ON products.id = order_items.product_id

        LEFT JOIN deliveries
          ON deliveries.order_id = orders.id

        WHERE orders.company_id = ?

        ORDER BY orders.id DESC
      `).all(req.session.companyId);

      return res.json({
        success: true,
        orders: rows
      });

    } catch (error) {
      console.error("Ошибка получения заказов:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить заказы."
      });
    }
  });

  // Финансовая сводка текущей компании; считаем только по orders,
  // чтобы соединения с позициями и доставкой не дублировали суммы.
  app.get("/api/seller/finance", requireLogin, async (req, res) => {
    try {
      const companyId = req.session.companyId;

      const summary = await db.prepare(`
        SELECT
          COALESCE(SUM(
            CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END
          ), 0) AS sales_total,
          COALESCE(SUM(
            CASE WHEN COALESCE(commission_rate_bps, 0) > 0
              AND payment_status = 'paid'
              THEN COALESCE(commission_amount, 0)
              ELSE 0
            END
          ), 0) AS commission_total,
          COALESCE(SUM(
            CASE WHEN COALESCE(commission_rate_bps, 0) > 0
              AND payment_status = 'paid'
              THEN COALESCE(seller_amount, 0)
              ELSE 0
            END
          ), 0) AS seller_amount_total,
          COUNT(*) AS order_count,
          COALESCE(SUM(
            CASE WHEN COALESCE(commission_rate_bps, 0) = 0
              AND payment_status = 'paid'
              THEN 1
              ELSE 0
            END
          ), 0) AS clarification_count
        FROM orders
        WHERE company_id = ?
      `).get(companyId);

      const rows = await db.prepare(`
        SELECT
          id,
          created_at,
          total_amount,
          commission_rate_bps,
          commission_amount,
          seller_amount
        FROM orders
        WHERE company_id = ?
        ORDER BY id DESC
      `).all(companyId);

      const orders = rows.map(order => {
        const commissionConfirmed = Number(order.commission_rate_bps) > 0;

        return {
          id: order.id,
          created_at: order.created_at,
          total_amount: order.total_amount,
          commission_rate_bps: order.commission_rate_bps,
          commission_amount: commissionConfirmed
            ? order.commission_amount
            : null,
          seller_amount: commissionConfirmed
            ? order.seller_amount
            : null,
          financial_status: commissionConfirmed
            ? "Подтверждено"
            : "Требует уточнения"
        };
      });

      return res.json({
        success: true,
        summary: {
          salesTotal: summary.sales_total,
          commissionTotal: summary.commission_total,
          sellerAmountTotal: summary.seller_amount_total,
          orderCount: summary.order_count,
          clarificationCount: summary.clarification_count
        },
        orders
      });
    } catch (error) {
      console.error("Ошибка получения финансов продавца:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось загрузить финансовую сводку."
      });
    }
  });

  // Изменение статуса заказа продавцом
  app.patch("/api/orders/:id/status", requireLogin, async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const newStatus = req.body?.status;
      const companyId = req.session.companyId;

      if (!Number.isSafeInteger(orderId) || orderId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Неверный номер заказа"
        });
      }

      const order = await db.prepare(`
        SELECT id, status
        FROM orders
        WHERE id = ? AND company_id = ?
      `).get(orderId, companyId);

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Заказ не найден"
        });
      }

      const nextStatuses = {
        new: "processing",
        processing: "ready_for_delivery",
        ready_for_delivery: "in_delivery",
        in_delivery: "completed"
      };

      if (nextStatuses[order.status] !== newStatus) {
        return res.status(400).json({
          success: false,
          message: "Недопустимое изменение статуса"
        });
      }

      if (order.status === "in_delivery" && newStatus === "completed") {
        const demoDelivery = await db.prepare(`
          SELECT is_demo
          FROM deliveries
          WHERE order_id = ?
        `).get(orderId);

        if (demoDelivery?.is_demo === 1) {
          return res.status(409).json({
            success: false,
            message: "Для демо-доставки используйте отдельное тестовое завершение."
          });
        }
      }

      if (newStatus === "in_delivery") {
        const delivery = await db.prepare(`
          SELECT delivery_status, provider_order_id
          FROM deliveries
          WHERE order_id = ?
        `).get(orderId);

        if (
          !delivery ||
          delivery.delivery_status !== "accepted_by_yandex" ||
          !delivery.provider_order_id
        ) {
          return res.status(409).json({
            success: false,
            message: "Нельзя передать заказ в доставку: Яндекс ещё не подтвердил оформление."
          });
        }
      }

      const updateOrder = db.transaction(async () => {
        const result = await db.prepare(`
          UPDATE orders
          SET status = ?
          WHERE id = ? AND company_id = ? AND status = ?
        `).run(newStatus, orderId, companyId, order.status);

        if (result.changes !== 1) {
          return false;
        }

        if (newStatus === "ready_for_delivery") {
          await db.prepare(`
            UPDATE deliveries
            SET delivery_status = 'awaiting_yandex_connection',
                updated_at = CURRENT_TIMESTAMP
            WHERE order_id = ?
              AND delivery_status = 'not_requested'
          `).run(orderId);
        }

        return true;
      });

      if (!await updateOrder()) {
        return res.status(409).json({
          success: false,
          message: "Статус заказа уже изменён. Обновите список заказов."
        });
      }

      let yandexDeliveryCheck;
      if (newStatus === "ready_for_delivery") {
        try {
          const check = await checkYandexDeliveryReady(db, orderId);
          yandexDeliveryCheck = {
            ready: check?.ready === true,
            reason: check?.ready === true
              ? null
              : (typeof check?.reason === "string"
                ? check.reason
                : "Не удалось подтвердить готовность к автоматической доставке.")
          };
        } catch {
          yandexDeliveryCheck = {
            ready: false,
            reason: "Не удалось проверить готовность к автоматической доставке."
          };
        }
      }

      return res.json({
        success: true,
        orderId,
        status: newStatus,
        ...(yandexDeliveryCheck ? { yandexDeliveryCheck } : {})
      });

    } catch (error) {
      console.error("Ошибка изменения статуса:", error);

      return res.status(500).json({
        success: false,
        message: "Не удалось изменить статус заказа"
      });
    }
  });

};

