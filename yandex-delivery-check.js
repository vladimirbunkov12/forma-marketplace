"use strict";

const { getSellerYandexKey } = require("./yandex-credentials");

async function checkYandexDeliveryReady(db, orderId) {
  const order = await db.prepare(`
    SELECT company_id, status
    FROM orders
    WHERE id = ?
  `).get(orderId);

  if (!order) {
    return { ready: false, reason: "Заказ не найден." };
  }

  if (order.status !== "ready_for_delivery") {
    return {
      ready: false,
      reason: "Заказ ещё не готов к передаче в доставку."
    };
  }

  const delivery = await db.prepare(`
    SELECT
      delivery_mode,
      delivery_provider,
      payment_by,
      delivery_status,
      provider_order_id
    FROM deliveries
    WHERE order_id = ?
  `).get(orderId);

  if (!delivery) {
    return { ready: false, reason: "Настройки доставки для заказа не найдены." };
  }

  if (delivery.delivery_mode !== "automatic") {
    return { ready: false, reason: "Для заказа не включена автоматическая доставка." };
  }

  if (delivery.delivery_provider !== "yandex") {
    return { ready: false, reason: "Для заказа не выбрана Яндекс Доставка." };
  }

  if (delivery.payment_by !== "seller" && delivery.payment_by !== "buyer") {
    return { ready: false, reason: "Не задан допустимый плательщик доставки FORMA." };
  }

  if (delivery.delivery_status !== "awaiting_yandex_connection") {
    return {
      ready: false,
      reason: "Заказ не ожидает подключения к Яндекс Доставке."
    };
  }

  if (delivery.provider_order_id) {
    return { ready: false, reason: "Заказ уже зарегистрирован у службы доставки." };
  }

  let apiKey;
  try {
    apiKey = await getSellerYandexKey(db, order.company_id);
  } catch {
    return { ready: false, reason: "Не удалось проверить API-ключ Яндекс Доставки продавца." };
  }

  if (!apiKey) {
    return { ready: false, reason: "Продавец не подключил Яндекс Доставку." };
  }

  return { ready: true, reason: null };
}

module.exports = { checkYandexDeliveryReady };
