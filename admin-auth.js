"use strict";

const path = require("path");

function createRequireAdmin(db) {
  return function requireAdmin(req, res, next) {
    try {
      const session = req.session || {};
      const adminId = session.adminId;
      const companyId = session.companyId;

      const admin = Number.isSafeInteger(adminId) && adminId > 0
        ? db.prepare("SELECT id FROM admin_users WHERE id = ?").get(adminId)
        : null;
      const seller = Number.isSafeInteger(companyId) && companyId > 0
        ? db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId)
        : null;

      // A session carrying both identities is ambiguous and must never gain admin access.
      if (admin && seller) {
        return res.status(403).json({
          success: false,
          message: "Сессия продавца не может использовать административный доступ."
        });
      }

      if (admin) return next();

      if (session.adminId !== undefined && session.adminId !== null) {
        session.adminId = null;
      }

      if (seller) {
        return res.status(403).json({
          success: false,
          message: "Доступ разрешён только администратору."
        });
      }

      return res.status(401).json({
        success: false,
        message: "Требуется действительная сессия администратора."
      });
    } catch (error) {
      console.error("Ошибка проверки административной сессии:", error);
      return res.status(500).json({
        success: false,
        message: "Не удалось проверить административный доступ."
      });
    }
  };
}

function requireSameOriginForMutations(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite && fetchSite.toLowerCase() === "cross-site") {
    return res.status(403).json({
      success: false,
      message: "Запрос отклонён проверкой CSRF."
    });
  }

  let expectedOrigin;
  let requestOrigin;
  try {
    expectedOrigin = new URL(`${req.protocol}://${req.get("host")}`).origin;
    const originHeader = req.get("origin");
    if (originHeader) {
      requestOrigin = new URL(originHeader).origin;
    } else {
      const refererHeader = req.get("referer");
      if (refererHeader) requestOrigin = new URL(refererHeader).origin;
    }
  } catch {
    requestOrigin = null;
  }

  if (!requestOrigin || requestOrigin !== expectedOrigin) {
    return res.status(403).json({
      success: false,
      message: "Запрос отклонён проверкой CSRF."
    });
  }

  return next();
}

function createAdminApiGuard(db) {
  const requireAdmin = createRequireAdmin(db);

  return function adminApiGuard(req, res, next) {
    res.set("Cache-Control", "no-store, private");

    return requireSameOriginForMutations(req, res, () => {
      // Only the existing credential-checked login endpoint is public.
      if (req.method === "POST" && req.path === "/login") {
        return next();
      }

      return requireAdmin(req, res, next);
    });
  };
}

function createAdminPageGuard(db, adminPagePath) {
  return function adminPageGuard(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let normalizedPath;
    try {
      normalizedPath = path.posix
        .normalize(decodeURIComponent(req.path))
        .toLowerCase();
    } catch {
      return res.status(400).send("Некорректный URL.");
    }

    if (normalizedPath !== "/admin.html") return next();

    res.set("Cache-Control", "no-store, private");

    try {
      const session = req.session || {};
      const adminId = session.adminId;
      const companyId = session.companyId;
      const admin = Number.isSafeInteger(adminId) && adminId > 0
        ? db.prepare("SELECT id FROM admin_users WHERE id = ?").get(adminId)
        : null;
      const seller = Number.isSafeInteger(companyId) && companyId > 0
        ? db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId)
        : null;

      if (admin && !seller) {
        return res.sendFile(adminPagePath);
      }

      if (session.adminId !== undefined && session.adminId !== null) {
        session.adminId = null;
      }

      return res.redirect(302, "/admin-login.html");
    } catch (error) {
      console.error("Ошибка проверки доступа к панели владельца:", error);
      return res.status(500).send("Не удалось проверить доступ к панели владельца.");
    }
  };
}

module.exports = {
  createRequireAdmin,
  createAdminApiGuard,
  createAdminPageGuard,
  requireSameOriginForMutations
};
