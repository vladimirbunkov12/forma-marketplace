"use strict";

module.exports = function registerDemoDeliveryRoutes(app, db, requireLogin) {
  app.post("/api/orders/:id/demo-delivery", requireLogin, async (req, res) => {
    try {
      // Демо-режим разрешён только вне production и при явном включении.
      if (process.env.NODE_ENV === "production" ||
          process.env.ENABLE_DEMO_DELIVERY !== "true") {
        return res.status(403).json({
          success: false,
          message: "Тестовая доставка отключена"
        });
      }

      const orderId = Number(req.params.id);
      const companyId = Number(req.session.companyId);

      if (!Number.isSafeInteger(orderId) || orderId <= 0 ||
          !Number.isSafeInteger(companyId) || companyId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Некорректные данные заказа"
        });
      }

      const result = await db.transaction(async () => {
        const order = await db.prepare(`
          SELECT id, status
          FROM orders
          WHERE id = ? AND company_id = ?
        `).get(orderId, companyId);

        if (!order) {
          return { code: 404, message: "Заказ не найден" };
        }

        if (order.status !== "ready_for_delivery") {
          return {
            code: 409,
            message: "Заказ ещё не готов к доставке"
          };
        }

        const delivery = await db.prepare(`
          SELECT delivery_status, provider_order_id, is_demo
          FROM deliveries
          WHERE order_id = ?
        `).get(orderId);

        if (!delivery) {
          return {
            code: 404,
            message: "Доставка не найдена"
          };
        }

        if (delivery.provider_order_id || delivery.is_demo === 1 ||
            delivery.delivery_status !== "awaiting_yandex_connection") {
          return {
            code: 409,
            message: "Доставка уже оформлена или недоступна для теста"
          };
        }

        await db.prepare(`
          UPDATE deliveries
          SET is_demo = 1,
              delivery_status = 'demo_accepted',
              updated_at = CURRENT_TIMESTAMP
          WHERE order_id = ?
            AND is_demo = 0
            AND provider_order_id IS NULL
            AND delivery_status = 'awaiting_yandex_connection'
        `).run(orderId);

        const markedDelivery = await db.prepare(`
          SELECT is_demo, provider_order_id, delivery_status
          FROM deliveries
          WHERE order_id = ?
        `).get(orderId);

        if (!markedDelivery || markedDelivery.is_demo !== 1 ||
            markedDelivery.provider_order_id ||
            markedDelivery.delivery_status !== "demo_accepted") {
          return {
            code: 409,
            message: "Демо-доставку уже обработали. Обновите список заказов."
          };
        }

        return { code: 200, message: "Демо-доставка создана" };
      })();

      return res.status(result.code).json({
        success: result.code === 200,
        demo: result.code === 200,
        message: result.message
      });
    } catch (error) {
      console.error("Ошибка демо-доставки:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось создать тестовую доставку"
      });
    }
  });

  const demoTransitions = [
    {
      path: "/api/orders/:id/demo-delivery/in-delivery",
      orderFrom: "ready_for_delivery",
      orderTo: "in_delivery",
      deliveryFrom: "demo_accepted",
      deliveryTo: "demo_in_delivery",
      message: "Демо-доставка отмечена как «В пути (демо)»"
    },
    {
      path: "/api/orders/:id/demo-delivery/completed",
      orderFrom: "in_delivery",
      orderTo: "completed",
      deliveryFrom: "demo_in_delivery",
      deliveryTo: "demo_completed",
      message: "Демо-доставка завершена"
    }
  ];

  for (const transition of demoTransitions) {
    app.patch(transition.path, requireLogin, async (req, res) => {
      try {
        if (process.env.NODE_ENV === "production" ||
            process.env.ENABLE_DEMO_DELIVERY !== "true") {
          return res.status(403).json({
            success: false,
            message: "Тестовая доставка отключена"
          });
        }

        const orderId = Number(req.params.id);
        const companyId = Number(req.session.companyId);
        if (!Number.isSafeInteger(orderId) || orderId <= 0 ||
            !Number.isSafeInteger(companyId) || companyId <= 0) {
          return res.status(400).json({
            success: false,
            message: "Некорректные данные заказа"
          });
        }

        const result = await db.transaction(async () => {
          const order = await db.prepare(`
            SELECT id, status
            FROM orders
            WHERE id = ? AND company_id = ?
          `).get(orderId, companyId);

          if (!order) {
            return { code: 404, message: "Заказ не найден" };
          }

          const delivery = await db.prepare(`
            SELECT is_demo, provider_order_id, delivery_status
            FROM deliveries
            WHERE order_id = ?
          `).get(orderId);

          if (!delivery) {
            return { code: 404, message: "Доставка не найдена" };
          }

          if (delivery.is_demo !== 1 || delivery.provider_order_id !== null) {
            return {
              code: 409,
              message: "Это не активная демо-доставка"
            };
          }

          if (order.status !== transition.orderFrom ||
              delivery.delivery_status !== transition.deliveryFrom) {
            return {
              code: 409,
              message: "Недопустимая последовательность статусов демо-доставки"
            };
          }

          const orderUpdate = await db.prepare(`
            UPDATE orders
            SET status = ?
            WHERE id = ? AND company_id = ? AND status = ?
          `).run(
            transition.orderTo,
            orderId,
            companyId,
            transition.orderFrom
          );

          const deliveryUpdate = await db.prepare(`
            UPDATE deliveries
            SET delivery_status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE order_id = ?
              AND is_demo = 1
              AND provider_order_id IS NULL
              AND delivery_status = ?
          `).run(
            transition.deliveryTo,
            orderId,
            transition.deliveryFrom
          );

          if (orderUpdate.changes !== 1 || deliveryUpdate.changes !== 1) {
            throw new Error("Статус демо-доставки изменился параллельно.");
          }

          return {
            code: 200,
            orderStatus: transition.orderTo,
            deliveryStatus: transition.deliveryTo,
            message: transition.message
          };
        })();

        return res.status(result.code).json({
          success: result.code === 200,
          demo: true,
          ...(result.orderStatus ? { orderStatus: result.orderStatus } : {}),
          ...(result.deliveryStatus
            ? { deliveryStatus: result.deliveryStatus }
            : {}),
          message: result.message
        });
      } catch (error) {
        console.error("Ошибка изменения статуса демо-доставки:", error);
        return res.status(500).json({
          success: false,
          message: "Не удалось изменить статус демо-доставки"
        });
      }
    });
  }
};
