"use strict";

const crypto = require("crypto");

function getEncryptionKey() {
  const secret = process.env.YANDEX_KEYS_SECRET;

  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error("YANDEX_KEYS_SECRET не настроен");
  }

  return Buffer.from(secret, "hex");
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);

  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

function decrypt(encryptedValue) {
  if (typeof encryptedValue !== "string") {
    throw new Error("Зашифрованный ключ отсутствует");
  }

  const parts = encryptedValue.split(":");

  if (parts.length !== 3) {
    throw new Error("Неверный формат зашифрованного ключа");
  }

  const [ivHex, tagHex, dataHex] = parts;

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
