"use strict";

const { decrypt } = require("./yandex-crypto");

async function getSellerYandexKey(db, companyId) {
  const row = await db.prepare(`
    SELECT yandex_api_key_encrypted
    FROM seller_delivery_settings
    WHERE company_id = ?
  `).get(companyId);

  if (!row?.yandex_api_key_encrypted) {
    return null;
  }

  return decrypt(row.yandex_api_key_encrypted);
}

module.exports = { getSellerYandexKey };
