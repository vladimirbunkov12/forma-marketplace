"use strict";

const path = require("path");
const pool = require("./postgres");

function createRequireAdmin(db) {
  return async function requireAdmin(req, res, next) {
    try {
      const session = req.session || {};
      const adminId = session.adminId;
      const companyId = session.companyId;

      const admin = Number.isSafeInteger(Number(adminId)) && Number(adminId) > 0
        ? (await pool.query("SELECT id FROM admin_users WHERE id = $1", [Number(adminId)])).rows[0]
        : null;
      const seller = Number.isSafeInteger(Number(companyId)) && Number(companyId) > 0
        ? (await pool.query("SELECT id FROM companies WHERE id = $1", [Number(companyId)])).rows[0]
        : null;

      // A session carrying both identities is ambiguous and must never gain admin access.
      if (admin && seller) {
        return res.status(403).json({
          success: false,
          message: "РЎРµСЃСЃРёСЏ РїСЂРѕРґР°РІС†Р° РЅРµ РјРѕР¶РµС‚ РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РёРІРЅС‹Р№ РґРѕСЃС‚СѓРї."
        });
      }

      if (admin) return next();

      if (session.adminId !== undefined && session.adminId !== null) {
        session.adminId = null;
      }

      if (seller) {
        return res.status(403).json({
          success: false,
          message: "Р”РѕСЃС‚СѓРї СЂР°Р·СЂРµС€С‘РЅ С‚РѕР»СЊРєРѕ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ."
        });
      }

      return res.status(401).json({
        success: false,
        message: "РўСЂРµР±СѓРµС‚СЃСЏ РґРµР№СЃС‚РІРёС‚РµР»СЊРЅР°СЏ СЃРµСЃСЃРёСЏ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР°."
      });
    } catch (error) {
      console.error("РћС€РёР±РєР° РїСЂРѕРІРµСЂРєРё Р°РґРјРёРЅРёСЃС‚СЂР°С‚РёРІРЅРѕР№ СЃРµСЃСЃРёРё:", error);
      return res.status(500).json({
        success: false,
        message: "РќРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕРІРµСЂРёС‚СЊ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РёРІРЅС‹Р№ РґРѕСЃС‚СѓРї."
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
      message: "Р—Р°РїСЂРѕСЃ РѕС‚РєР»РѕРЅС‘РЅ РїСЂРѕРІРµСЂРєРѕР№ CSRF."
    });
  }

  let expectedOrigin;
  let requestOrigin;
  try {
    // Use req.protocol only. Express derives it from X-Forwarded-Proto *only*
    // when "trust proxy" is configured (Render sets it in production), so a
    // client-supplied X-Forwarded-Proto on a direct/plain-HTTP connection is
    // ignored and cannot be used to forge the expected origin for CSRF.
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
      message: "Р—Р°РїСЂРѕСЃ РѕС‚РєР»РѕРЅС‘РЅ РїСЂРѕРІРµСЂРєРѕР№ CSRF."
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
  return async function adminPageGuard(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let normalizedPath;
    try {
      normalizedPath = path.posix
        .normalize(decodeURIComponent(req.path))
        .toLowerCase();
    } catch {
      return res.status(400).send("РќРµРєРѕСЂСЂРµРєС‚РЅС‹Р№ URL.");
    }

    if (normalizedPath !== "/admin.html") return next();

    res.set("Cache-Control", "no-store, private");

    try {
      const session = req.session || {};
      const adminId = session.adminId;
      const companyId = session.companyId;
      const admin = Number.isSafeInteger(Number(adminId)) && Number(adminId) > 0
        ? (await pool.query("SELECT id FROM admin_users WHERE id = $1", [Number(adminId)])).rows[0]
        : null;
      const seller = Number.isSafeInteger(Number(companyId)) && Number(companyId) > 0
        ? (await pool.query("SELECT id FROM companies WHERE id = $1", [Number(companyId)])).rows[0]
        : null;

      if (admin && !seller) {
        return res.sendFile(adminPagePath);
      }

      if (session.adminId !== undefined && session.adminId !== null) {
        session.adminId = null;
      }

      return res.redirect(302, "/admin-login.html");
    } catch (error) {
      console.error("РћС€РёР±РєР° РїСЂРѕРІРµСЂРєРё РґРѕСЃС‚СѓРїР° Рє РїР°РЅРµР»Рё РІР»Р°РґРµР»СЊС†Р°:", error);
      return res.status(500).send("РќРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕРІРµСЂРёС‚СЊ РґРѕСЃС‚СѓРї Рє РїР°РЅРµР»Рё РІР»Р°РґРµР»СЊС†Р°.");
    }
  };
}

module.exports = {
  createRequireAdmin,
  createAdminApiGuard,
  createAdminPageGuard,
  requireSameOriginForMutations
};

