
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const crypto = require("crypto");
const multer = require("multer");
const { uploadImage } = require("./cloudinary-storage");
const rateLimit = require("express-rate-limit");
const BetterSqlite3 = require("better-sqlite3");
const db = require("./pg-buyer-db");
const registerDeliveryRoutes = require("./delivery-routes");
const registerBuyerRoutes = require("./buyer-routes");
const registerBuyerCartRoutes = require("./buyer-cart-routes");
const registerBuyerCheckoutRoutes = require("./buyer-checkout-routes");
const registerAdminRoutes = require("./admin-routes");
const registerSellerCommissionRoutes = require("./seller-commission-routes");
const registerSellerPaymentRoutes = require("./seller-payment-routes");
const registerDemoDeliveryRoutes = require("./demo-delivery-routes");
const {
  createAdminApiGuard,
  createAdminPageGuard, requireSameOriginForMutations
} = require("./admin-auth");
const COMMISSION_AGREEMENT_VERSION = "1.0";

const app = express();

if (process.env.RENDER === "true" && process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}
const PORT = process.env.PORT || 3000;

// Р”РѕРІРµСЂСЏРµРј С‚РѕР»СЊРєРѕ СЏРІРЅРѕ Р·Р°РґР°РЅРЅС‹Рј HTTPS reverse proxy Р°РґСЂРµСЃР°Рј РІ production.
// РџСЂРѕРєСЃРё РґРѕР»Р¶РµРЅ РїРµСЂРµР·Р°РїРёСЃС‹РІР°С‚СЊ X-Forwarded-* Р·Р°РіРѕР»РѕРІРєРё РѕС‚ РІРЅРµС€РЅРµРіРѕ РєР»РёРµРЅС‚Р°.
if (
  process.env.NODE_ENV === "production" &&
  process.env.HTTPS_PROXY_TERMINATION === "true" &&
  process.env.TRUST_PROXY_IPS
) {
  const trustedProxyIps = process.env.TRUST_PROXY_IPS
    .split(",")
    .map(address => address.trim())
    .filter(Boolean);

  if (trustedProxyIps.length > 0) {
    try {
      app.set("trust proxy", trustedProxyIps);
    } catch {
      throw new Error(
        "TRUST_PROXY_IPS РґРѕР»Р¶РµРЅ СЃРѕРґРµСЂР¶Р°С‚СЊ РєРѕСЂСЂРµРєС‚РЅС‹Рµ Р°РґСЂРµСЃР° РґРѕРІРµСЂРµРЅРЅРѕРіРѕ HTTPS-РїСЂРѕРєСЃРё."
      );
    }
  }
}

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "20kb"
}));

// РЎРµСЃСЃРёРё РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№
const sessionSecret =
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");

if (!process.env.SESSION_SECRET) {
  console.warn(
    "Р’РќРРњРђРќРР•: РІСЂРµРјРµРЅРЅС‹Р№ РєР»СЋС‡ СЃРµСЃСЃРёР№. " +
    "Р”Р»СЏ РїСѓР±Р»РёРєР°С†РёРё Р·Р°РґР°Р№С‚Рµ SESSION_SECRET."
  );
}

// РћРіСЂР°РЅРёС‡РµРЅРёРµ РїРѕРїС‹С‚РѕРє РІС…РѕРґР°: 5 Р·Р°РїСЂРѕСЃРѕРІ Р·Р° 15 РјРёРЅСѓС‚ СЃ РѕРґРЅРѕРіРѕ IP.
// Р”РµР№СЃС‚РІСѓРµС‚ РґР»СЏ РІС…РѕРґР° РїСЂРѕРґР°РІС†Р°, Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР° Рё РїРѕРєСѓРїР°С‚РµР»СЏ.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "РЎР»РёС€РєРѕРј РјРЅРѕРіРѕ РїРѕРїС‹С‚РѕРє РІС…РѕРґР°. РџРѕРїСЂРѕР±СѓР№С‚Рµ РїРѕР·Р¶Рµ С‡РµСЂРµР· 15 РјРёРЅСѓС‚."
  },
  standardHeaders: true,
  legacyHeaders: false,
});


let sessionStore;

if (process.env.DATABASE_URL) {
  console.log("DATABASE HOST:", new URL(process.env.DATABASE_URL).hostname);
  const PgSessionStore = require("connect-pg-simple")(session);

  sessionStore = new PgSessionStore({
    pool: require("./postgres"),
    tableName: "session",
    createTableIfMissing: false
  });

  console.log("SESSION STORE: POSTGRESQL");
} else {
  const sessionDb = new BetterSqlite3(
    path.join(__dirname, "sessions.db")
  );

  const SqliteSessionStore =
    require("better-sqlite3-session-store")(session);

  sessionStore = new SqliteSessionStore({
    client: sessionDb,
    expired: {
      clear: true,
      intervalMs: 15 * 60 * 1000
    }
  });

  console.log("SESSION STORE: SQLITE");
}

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Central defense-in-depth gate for every admin API, including future routes.
app.use("/api/admin", createAdminApiGuard(db));
app.use("/api/buyer", requireSameOriginForMutations);

// РџР°РїРєР° С„РѕС‚РѕРіСЂР°С„РёР№
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// РќР°СЃС‚СЂРѕР№РєР° Р·Р°РіСЂСѓР·РєРё С„РѕС‚РѕРіСЂР°С„РёР№
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 8
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("РќРµРґРѕРїСѓСЃС‚РёРјС‹Р№ С„РѕСЂРјР°С‚ С„РѕС‚РѕРіСЂР°С„РёРё."));
    }

    cb(null, true);
  }
});

// РџСЂРѕРІРµСЂРєР° РІС…РѕРґР°
async function requireLogin(req, res, next) {
  if (!req.session.companyId) {
    return res.status(401).json({
      success: false,
      message: "РЎРЅР°С‡Р°Р»Р° РІРѕР№РґРёС‚Рµ РІ Р°РєРєР°СѓРЅС‚."
    });
  }

  try {
    const company = await db.prepare(`
      SELECT is_blocked
      FROM companies
      WHERE id = ?
    `).get(req.session.companyId);

    if (!company) {
      req.session.destroy(() => {});
      return res.status(401).json({
        success: false,
        message: "РђРєРєР°СѓРЅС‚ РЅРµ РЅР°Р№РґРµРЅ."
      });
    }

    if (company.is_blocked === 1) {
      req.session.destroy(() => {});
      return res.status(403).json({
        success: false,
        message: "Р’Р°С€ Р°РєРєР°СѓРЅС‚ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ."
      });
    }

    next();
  } catch (error) {
    console.error("РћС€РёР±РєР° РїСЂРѕРІРµСЂРєРё Р°РєРєР°СѓРЅС‚Р°:", error);

    return res.status(500).json({
      success: false,
      message: "РћС€РёР±РєР° РїСЂРѕРІРµСЂРєРё РґРѕСЃС‚СѓРїР°."
    });
  }
}

// Protect the admin document before the public static middleware can serve it.
app.use(createAdminPageGuard(
  db,
  path.join(__dirname, "public", "admin.html")
));

// РЎС‚СЂР°РЅРёС†С‹ СЃР°Р№С‚Р°
const publicPages = new Set(["index.html","catalog.html","checkout.html","dashboard.html","login.html","register.html","admin.html","admin-login.html","buyer-account.html","buyer-register.html","buyer-cart.html","buyer-payment.html","auth-choice.html","add-product.html","edit-product.html","seller-prices.html","styles.css"]);
app.use((req,res,next) => {
  if (req.path === "/" || publicPages.has(req.path.slice(1))) return express.static(path.join(__dirname,"public"))(req,res,next);
  next();
});

app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/register", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/login", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/auth-choice", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "auth-choice.html"));
});

app.get("/buyer-register", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "buyer-register.html"));
});

app.get("/buyer-account", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "buyer-account.html"));
});

app.get("/buyer-cart", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "buyer-cart.html"));
});

app.get("/buyer-payment", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "buyer-payment.html"));
});

// Р РµРіРёСЃС‚СЂР°С†РёСЏ РєРѕРјРїР°РЅРёРё
app.post("/register", async (req, res) => {
  try {
    const {
      company_name,
      city,
      phone,
      email,
      password,
      agreement_accepted,
      agreement_version
    } = req.body || {};

    if (
      agreement_accepted !== true ||
      agreement_version !== COMMISSION_AGREEMENT_VERSION
    ) {
      return res.status(400).json({
        success: false,
        message: "Р”Р»СЏ СЂРµРіРёСЃС‚СЂР°С†РёРё РЅРµРѕР±С…РѕРґРёРјРѕ РїСЂРёРЅСЏС‚СЊ СЃРѕРіР»Р°С€РµРЅРёРµ Рѕ РєРѕРјРёСЃСЃРёРё РІРµСЂСЃРёРё 1.0."
      });
    }

    if (
      typeof company_name !== "string" ||
      typeof city !== "string" ||
      typeof phone !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !company_name.trim() ||
      !city.trim() ||
      !phone.trim() ||
      !email.trim() ||
      password.length < 8 ||
      company_name.length > 150 ||
      city.length > 100 ||
      phone.length > 30 ||
      email.length > 254 ||
      password.length > 128
    ) {
      return res.status(400).json({
        success: false,
        message: "РџСЂРѕРІРµСЂСЊС‚Рµ РїРѕР»СЏ. РџР°СЂРѕР»СЊ: РѕС‚ 8 РґРѕ 128 СЃРёРјРІРѕР»РѕРІ."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Р’РІРµРґРёС‚Рµ РїСЂР°РІРёР»СЊРЅСѓСЋ РїРѕС‡С‚Сѓ."
      });
    }

    const existing = await db.prepare(
      "SELECT id FROM companies WHERE email = ?"
    ).get(normalizedEmail);

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "РўР°РєР°СЏ РїРѕС‡С‚Р° СѓР¶Рµ Р·Р°СЂРµРіРёСЃС‚СЂРёСЂРѕРІР°РЅР°."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await db.prepare(`
      INSERT INTO companies
      (company_name, city, phone, email, password_hash,
       commission_agreement_version, commission_agreement_accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      company_name.trim(),
      city.trim(),
      phone.trim(),
      normalizedEmail,
      passwordHash,
      COMMISSION_AGREEMENT_VERSION
    );

    res.status(201).json({
      success: true,
      message: "РљРѕРјРїР°РЅРёСЏ СѓСЃРїРµС€РЅРѕ Р·Р°СЂРµРіРёСЃС‚СЂРёСЂРѕРІР°РЅР°!"
    });
  } catch (error) {
    console.error("РћС€РёР±РєР° СЂРµРіРёСЃС‚СЂР°С†РёРё:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "РўР°РєР°СЏ РїРѕС‡С‚Р° СѓР¶Рµ Р·Р°СЂРµРіРёСЃС‚СЂРёСЂРѕРІР°РЅР°."
      });
    }

    res.status(500).json({
      success: false,
      message: "РћС€РёР±РєР° СЃРµСЂРІРµСЂР°."
    });
  }
});

// Р’С…РѕРґ РІ Р°РєРєР°СѓРЅС‚
app.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Р’РІРµРґРёС‚Рµ РїРѕС‡С‚Сѓ Рё РїР°СЂРѕР»СЊ."
      });
    }

    const company = await db.prepare(
      "SELECT * FROM companies WHERE email = ?"
    ).get(email.trim().toLowerCase());

    if (!company) {
      return res.status(401).json({
        success: false,
        message: "РќРµРІРµСЂРЅР°СЏ РїРѕС‡С‚Р° РёР»Рё РїР°СЂРѕР»СЊ."
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      company.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "РќРµРІРµСЂРЅР°СЏ РїРѕС‡С‚Р° РёР»Рё РїР°СЂРѕР»СЊ."
      });
    }

    if (company.is_blocked === 1) {
      return res.status(403).json({
        success: false,
        message: "Р’Р°С€ Р°РєРєР°СѓРЅС‚ Р·Р°Р±Р»РѕРєРёСЂРѕРІР°РЅ. РћР±СЂР°С‚РёС‚РµСЃСЊ Рє Р°РґРјРёРЅРёСЃС‚СЂР°С†РёРё FORMA."
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error("РћС€РёР±РєР° СЃРµСЃСЃРёРё:", error);
        return res.status(500).json({
          success: false,
          message: "РћС€РёР±РєР° РІС…РѕРґР°."
        });
      }

      req.session.companyId = String(company.id);

      req.session.save((error) => {
        if (error) {
          console.error("РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ СЃРµСЃСЃРёРё:", error);
          return res.status(500).json({
            success: false,
            message: "РћС€РёР±РєР° РІС…РѕРґР°."
          });
        }

        res.json({
          success: true,
          message: "Р’С…РѕРґ РІС‹РїРѕР»РЅРµРЅ СѓСЃРїРµС€РЅРѕ!",
          company: {
            id: company.id,
            name: company.company_name,
            city: company.city
          }
        });
      });
    });
  } catch (error) {
    console.error("РћС€РёР±РєР° РІС…РѕРґР°:", error);
    res.status(500).json({
      success: false,
      message: "РћС€РёР±РєР° СЃРµСЂРІРµСЂР°."
    });
  }
});

// Р”Р°РЅРЅС‹Рµ РєРѕРјРїР°РЅРёРё
app.get("/api/me", requireLogin, async (req, res) => {
  const company = await db.prepare(`
    SELECT
      id,
      company_name,
      city,
      phone,
      email,
      pickup_address
    FROM companies
    WHERE id = ?
  `).get(req.session.companyId);

  if (!company) {
    return res.status(401).json({
      success: false,
      message: "РђРєРєР°СѓРЅС‚ РЅРµ РЅР°Р№РґРµРЅ."
    });
  }

  res.json({
    success: true,
    company
  });
});

app.patch("/api/me/pickup-address", requireLogin, async (req, res) => {
  try {
    const address = req.body?.pickup_address;

    if (
      typeof address !== "string" ||
      address.trim().length < 5 ||
      address.trim().length > 300
    ) {
      return res.status(400).json({
        success: false,
        message: "РЈРєР°Р¶РёС‚Рµ Р°РґСЂРµСЃ СЃРєР»Р°РґР° РѕС‚ 5 РґРѕ 300 СЃРёРјРІРѕР»РѕРІ"
      });
    }

    const normalizedAddress = address.trim();
    const result = await db.prepare(`
      UPDATE companies
      SET pickup_address = ?
      WHERE id = ?
    `).run(normalizedAddress, req.session.companyId);

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        message: "РљРѕРјРїР°РЅРёСЏ РЅРµ РЅР°Р№РґРµРЅР°"
      });
    }

    return res.json({
      success: true,
      message: "РђРґСЂРµСЃ СЃРєР»Р°РґР° СѓСЃРїРµС€РЅРѕ СЃРѕС…СЂР°РЅС‘РЅ!",
      pickup_address: normalizedAddress
    });

  } catch (error) {
    console.error("РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ Р°РґСЂРµСЃР° СЃРєР»Р°РґР°:", error);

    return res.status(500).json({
      success: false,
      message: "РћС€РёР±РєР° СЃРµСЂРІРµСЂР°"
    });
  }
});

// РџСѓР±Р»РёРєР°С†РёСЏ РјРµР±РµР»Рё
app.post(
  "/api/products",
  requireLogin,
  upload.single("photo"),
  async (req, res) => {
    try {
      const { name, category, price, description } = req.body;

      const categories = [
  "РљСѓС…РЅРё",
  "РЁРєР°С„С‹",
  "Р”РёРІР°РЅС‹",
  "РљСЂРѕРІР°С‚Рё",
  "РЎС‚РѕР»С‹",
  "Р”СЂСѓРіР°СЏ РјРµР±РµР»СЊ"
];

      const priceNumber = Number(price);

      // РҐР°СЂР°РєС‚РµСЂРёСЃС‚РёРєРё СѓРїР°РєРѕРІРєРё РґР»СЏ РґРѕСЃС‚Р°РІРєРё
      const deliveryFields = [
        "weight_kg",
        "length_cm",
        "width_cm",
        "height_cm"
      ];

      let deliveryValues;
      try {
        deliveryValues = deliveryFields.map((field) => {
          const raw = req.body[field];

          if (raw === undefined || raw === "") {
            return null;
          }

          const value = Number(raw);

          if (
            !Number.isFinite(value) ||
            value <= 0 ||
            value > 100000
          ) {
            throw new Error("РќРµРєРѕСЂСЂРµРєС‚РЅРѕРµ Р·РЅР°С‡РµРЅРёРµ: " + field);
          }

          return value;
        });
      } catch (error) {
        if (req.file) {
        }

        return res.status(400).json({
          success: false,
          message: error.message
        });
      }

      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 150 ||
        !categories.includes(category) ||
        !/^\d+$/.test(String(price)) ||
        !Number.isSafeInteger(priceNumber) ||
        priceNumber <= 0 ||
        typeof description !== "string" ||
        !description.trim() ||
        description.length > 3000 ||
        !req.file
      ) {
        if (req.file) {
        }

        return res.status(400).json({
          success: false,
          message: "РџСЂРѕРІРµСЂСЊС‚Рµ РЅР°Р·РІР°РЅРёРµ, РєР°С‚РµРіРѕСЂРёСЋ, С†РµРЅСѓ, РѕРїРёСЃР°РЅРёРµ Рё С„РѕС‚РѕРіСЂР°С„РёСЋ."
        });
      }

      // РџСЂРѕРІРµСЂСЏРµРј СЃРёРіРЅР°С‚СѓСЂСѓ РёР·РѕР±СЂР°Р¶РµРЅРёСЏ
      const bytes = req.file.buffer.subarray(0, 12);

      const isJpeg =
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const isPng =
        bytes.subarray(0, 8).equals(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        );
      const isWebp =
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";

      const validPhoto = (
        (req.file.mimetype === "image/jpeg" && isJpeg) ||
        (req.file.mimetype === "image/png" && isPng) ||
        (req.file.mimetype === "image/webp" && isWebp)
      );

      if (!validPhoto) {
        return res.status(400).json({
          success: false,
          message: "Р¤Р°Р№Р» РЅРµ СЏРІР»СЏРµС‚СЃСЏ РґРѕРїСѓСЃС‚РёРјРѕР№ С„РѕС‚РѕРіСЂР°С„РёРµР№."
        });
      }

      const company = await db.prepare(
        "SELECT id FROM companies WHERE id = ?"
      ).get(req.session.companyId);

      if (!company) {
        return res.status(401).json({
          success: false,
          message: "РђРєРєР°СѓРЅС‚ РЅРµ РЅР°Р№РґРµРЅ."
        });
      }

      const photoUrl = await uploadImage(req.file.buffer);
      const result = await db.prepare(`
        INSERT INTO products
        (
          company_id, name, category, price, description, photo,
          weight_kg, length_cm, width_cm, height_cm
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        company.id,
        name.trim(),
        category,
        priceNumber,
        description.trim(),
        photoUrl,
        ...deliveryValues
      );

      res.status(201).json({
        success: true,
        message: "РўРѕРІР°СЂ СѓСЃРїРµС€РЅРѕ РѕРїСѓР±Р»РёРєРѕРІР°РЅ!",
        productId: result.lastInsertRowid.toString()
      });
    } catch (error) {
      console.error("РћС€РёР±РєР° РїСѓР±Р»РёРєР°С†РёРё:", error);

      if (req.file) {
      }

      res.status(500).json({
        success: false,
        message: "РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ С‚РѕРІР°СЂ."
      });
    }
  }
);

// РЎРїРёСЃРѕРє С‚РѕРІР°СЂРѕРІ
app.get("/api/products", async (req, res) => {
  try {
    const products = await db.prepare(`
      SELECT
        products.id,
        products.name,
        products.category,
        products.price,
        products.description,
        products.photo,
        products.created_at,
        companies.id AS company_id,
        companies.company_name,
        companies.city,
        companies.phone AS company_phone,
        COALESCE(seller_prices.kitchen_per_meter, 0) AS kitchen_per_meter,
        COALESCE(seller_prices.wardrobe_per_sqm, 0) AS wardrobe_per_sqm
      FROM products
      JOIN companies ON companies.id = products.company_id
      LEFT JOIN seller_prices
        ON seller_prices.company_id = companies.id
      ORDER BY products.id DESC
    `).all();

    res.json({
      success: true,
      products: products.map((product) => ({
        ...product,
        photoUrl: /^https?:\/\//i.test(product.photo) ? product.photo : "/uploads/" + product.photo
      }))
    });
  } catch (error) {
    console.error("РћС€РёР±РєР° РїРѕР»СѓС‡РµРЅРёСЏ С‚РѕРІР°СЂРѕРІ:", error);

    res.status(500).json({
      success: false,
      message: "РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ С‚РѕРІР°СЂС‹."
    });
  }
});

// РџРѕРєР°Р·С‹РІР°РµРј С„РѕС‚РѕРіСЂР°С„РёРё
app.use("/uploads", express.static(uploadsDir));

// Р’С‹С…РѕРґ РёР· Р°РєРєР°СѓРЅС‚Р°
app.post("/logout", async (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "РќРµ СѓРґР°Р»РѕСЃСЊ РІС‹Р№С‚Рё."
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true,
      message: "Р’С‹ РІС‹С€Р»Рё РёР· Р°РєРєР°СѓРЅС‚Р°."
    });
  });
});

// РћС€РёР±РєРё Р·Р°РіСЂСѓР·РєРё С„РѕС‚РѕРіСЂР°С„РёР№
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Р¤РѕС‚РѕРіСЂР°С„РёСЏ РЅРµ РґРѕР»Р¶РЅР° РїСЂРµРІС‹С€Р°С‚СЊ 5 РњР‘."
        : "РћС€РёР±РєР° Р·Р°РіСЂСѓР·РєРё С„РѕС‚РѕРіСЂР°С„РёРё."
    });
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "РћС€РёР±РєР° Р·Р°РїСЂРѕСЃР°."
    });
  }

  next();
});

// Р—Р°РїСѓСЃРє СЃРµСЂРІРµСЂР°
app.put("/api/products/:id", requireLogin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, category, price, description } = req.body;

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "РќРµРІРµСЂРЅС‹Р№ ID С‚РѕРІР°СЂР°"
      });
    }

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof category !== "string" ||
      !category.trim() ||
      typeof description !== "string" ||
      !description.trim() ||
      !Number.isFinite(Number(price)) ||
      Number(price) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Р—Р°РїРѕР»РЅРёС‚Рµ РІСЃРµ РїРѕР»СЏ РїСЂР°РІРёР»СЊРЅРѕ"
      });
    }

    const product = await db.prepare(`
      SELECT id, weight_kg, length_cm, width_cm, height_cm FROM products
      WHERE id = ? AND company_id = ?
    `).get(id, req.session.companyId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "РўРѕРІР°СЂ РЅРµ РЅР°Р№РґРµРЅ"
      });
    }

    const deliveryFields = [
      "weight_kg",
      "length_cm",
      "width_cm",
      "height_cm"
    ];
    const deliveryValues = {};

    for (const field of deliveryFields) {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) {
        deliveryValues[field] = product[field];
        continue;
      }

      const rawValue = req.body[field];
      if (rawValue === null || rawValue === "") {
        deliveryValues[field] = null;
        continue;
      }

      if (typeof rawValue !== "number" && typeof rawValue !== "string") {
        return res.status(400).json({
          success: false,
          message: "РќРµРєРѕСЂСЂРµРєС‚РЅРѕРµ Р·РЅР°С‡РµРЅРёРµ: " + field
        });
      }

      const value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0 || value > 100000) {
        return res.status(400).json({
          success: false,
          message: "РќРµРєРѕСЂСЂРµРєС‚РЅРѕРµ Р·РЅР°С‡РµРЅРёРµ: " + field
        });
      }

      deliveryValues[field] = value;
    }

    await db.prepare(`
      UPDATE products
      SET
        name = ?, category = ?, price = ?, description = ?,
        weight_kg = ?, length_cm = ?, width_cm = ?, height_cm = ?
      WHERE id = ? AND company_id = ?
    `).run(
      name.trim(),
      category.trim(),
      Number(price),
      description.trim(),
      deliveryValues.weight_kg,
      deliveryValues.length_cm,
      deliveryValues.width_cm,
      deliveryValues.height_cm,
      id,
      req.session.companyId
    );

    res.json({
      success: true,
      message: "РўРѕРІР°СЂ СѓСЃРїРµС€РЅРѕ РѕР±РЅРѕРІР»С‘РЅ"
    });

  } catch (error) {
    console.error("РћС€РёР±РєР° СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРёСЏ:", error);

    res.status(500).json({
      success: false,
      message: "РћС€РёР±РєР° РѕР±РЅРѕРІР»РµРЅРёСЏ С‚РѕРІР°СЂР°"
    });
  }
});

app.delete("/api/products/:id", requireLogin, async (req, res) => {



  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "РќРµРІРµСЂРЅС‹Р№ ID С‚РѕРІР°СЂР°"
      });
    }

    const product = await db.prepare(`
      SELECT id FROM products
      WHERE id = ? AND company_id = ?
    `).get(id, req.session.companyId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "РўРѕРІР°СЂ РЅРµ РЅР°Р№РґРµРЅ"
      });
    }

    await db.prepare(`
      DELETE FROM products
      WHERE id = ? AND company_id = ?
    `).run(id, req.session.companyId);

    res.json({
      success: true,
      message: "РўРѕРІР°СЂ СѓРґР°Р»С‘РЅ"
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "РћС€РёР±РєР° СѓРґР°Р»РµРЅРёСЏ С‚РѕРІР°СЂР°"
    });
  }
});


app.put("/api/products/:id/photo", requireLogin, upload.single("photo"), async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Неверный ID товара"
      });
    }

    const product = await db.prepare(
      "SELECT id FROM products WHERE id = ? AND company_id = ?"
    ).get(id, req.session.companyId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Товар не найден"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Выберите фотографию"
      });
    }

    const bytes = req.file.buffer.subarray(0, 12);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
    const isWebp = bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";

    const validPhoto =
      (req.file.mimetype === "image/jpeg" && isJpeg) ||
      (req.file.mimetype === "image/png" && isPng) ||
      (req.file.mimetype === "image/webp" && isWebp);

    if (!validPhoto) {
      return res.status(400).json({
        success: false,
        message: "Недопустимый формат фотографии"
      });
    }

    const photoUrl = await uploadImage(req.file.buffer);

    await db.prepare(
      "UPDATE products SET photo = ? WHERE id = ? AND company_id = ?"
    ).run(photoUrl, id, req.session.companyId);

    return res.json({
      success: true,
      message: "Фотография обновлена"
    });
  } catch (error) {
    console.error("Ошибка обновления фотографии:", error);

    return res.status(500).json({
      success: false,
      message: "Ошибка обновления фотографии"
    });
  }
});

/* FORMA MARKETPLACE вЂ” СЂР°СЃС†РµРЅРєРё РїСЂРѕРґР°РІС†РѕРІ */

// РџРѕР»СѓС‡РёС‚СЊ СЂР°СЃС†РµРЅРєРё СЃРІРѕРµР№ РєРѕРјРїР°РЅРёРё
app.get("/api/seller-prices", requireLogin, async (req, res) => {
  try {
    const prices = await db.prepare(`
      SELECT kitchen_per_meter, wardrobe_per_sqm
      FROM seller_prices
      WHERE company_id = ?
    `).get(req.session.companyId);

    res.json({
      success: true,
      prices: prices || {
        kitchen_per_meter: 0,
        wardrobe_per_sqm: 0
      }
    });
  } catch (error) {
    console.error("РћС€РёР±РєР° РїРѕР»СѓС‡РµРЅРёСЏ СЂР°СЃС†РµРЅРѕРє:", error);

    res.status(500).json({
      success: false,
      message: "РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕР»СѓС‡РёС‚СЊ СЂР°СЃС†РµРЅРєРё"
    });
  }
});

// РЎРѕС…СЂР°РЅРёС‚СЊ СЂР°СЃС†РµРЅРєРё СЃРІРѕРµР№ РєРѕРјРїР°РЅРёРё
app.put("/api/seller-prices", requireLogin, async (req, res) => {
  try {
    const kitchen = Number(req.body?.kitchen_per_meter);
    const wardrobe = Number(req.body?.wardrobe_per_sqm);

    if (
      !Number.isSafeInteger(kitchen) ||
      !Number.isSafeInteger(wardrobe) ||
      kitchen < 0 ||
      wardrobe < 0 ||
      kitchen > 100000000 ||
      wardrobe > 100000000
    ) {
      return res.status(400).json({
        success: false,
        message: "Р’РІРµРґРёС‚Рµ РєРѕСЂСЂРµРєС‚РЅС‹Рµ С†РµРЅС‹ РІ С‚РµРЅРіРµ"
      });
    }

    await db.prepare(`
      INSERT INTO seller_prices (
        company_id,
        kitchen_per_meter,
        wardrobe_per_sqm,
        updated_at
      )
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(company_id)
      DO UPDATE SET
        kitchen_per_meter = excluded.kitchen_per_meter,
        wardrobe_per_sqm = excluded.wardrobe_per_sqm,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      req.session.companyId,
      kitchen,
      wardrobe
    );

    res.json({
      success: true,
      message: "Р Р°СЃС†РµРЅРєРё СЃРѕС…СЂР°РЅРµРЅС‹"
    });

  } catch (error) {
    console.error("РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ СЂР°СЃС†РµРЅРѕРє:", error);

    res.status(500).json({
      success: false,
      message: "РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ СЂР°СЃС†РµРЅРєРё"
    });
  }
});


registerSellerCommissionRoutes(app, db, requireLogin);
registerSellerPaymentRoutes(app, db, requireLogin);
registerDemoDeliveryRoutes(app, db, requireLogin);
registerBuyerRoutes(app, db);
require("./buyer-profile-routes")(app, db);
registerBuyerCartRoutes(app, db);
registerBuyerCheckoutRoutes(app, db);
require("./buyer-order-routes")(app, db);
registerDeliveryRoutes(app, db, requireLogin);
const registerYandexSettings = require("./yandex-settings");
registerYandexSettings(app, db, requireLogin);
registerAdminRoutes(app, db);

// Production pre-flight: Р·Р°РїСЂРµС‚ Р·Р°РїСѓСЃРєР° СЃ РґРµРјРѕРЅСЃС‚СЂР°С†РёРѕРЅРЅРѕР№ РґРѕСЃС‚Р°РІРєРѕР№,
// РЅРµР±РµР·РѕРїР°СЃРЅС‹Рј SESSION_SECRET РёР»Рё Р±РёС‚РѕР№ РЅР°СЃС‚СЂРѕР№РєРѕР№ YANDEX_KEYS_SECRET.
// Р—РЅР°С‡РµРЅРёСЏ СЃРµРєСЂРµС‚РѕРІ РІ РѕС€РёР±РєР°С… РЅРµ РІС‹РІРѕРґСЏС‚СЃСЏ.
if (process.env.NODE_ENV === "production") {
  const problems = [];

  if (
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32
  ) {
    problems.push(
      "SESSION_SECRET РЅРµ Р·Р°РґР°РЅ РёР»Рё СЃР»РёС€РєРѕРј РєРѕСЂРѕС‚РєРёР№ (РјРёРЅРёРјСѓРј 32 СЃРёРјРІРѕР»Р°)."
    );
  }

  if (process.env.ENABLE_DEMO_DELIVERY === "true") {
    problems.push(
      "ENABLE_DEMO_DELIVERY=true: РґРµРјРѕРЅСЃС‚СЂР°С†РёРѕРЅРЅР°СЏ РґРѕСЃС‚Р°РІРєР° РЅРµ СЂР°Р·СЂРµС€РµРЅР° РІ production."
    );
  }

  if (
    process.env.YANDEX_KEYS_SECRET !== undefined &&
    !/^[0-9a-f]{64}$/i.test(process.env.YANDEX_KEYS_SECRET)
  ) {
    problems.push(
      "YANDEX_KEYS_SECRET Р·Р°РґР°РЅ РЅРµРІРµСЂРЅРѕ: РѕР¶РёРґР°РµС‚СЃСЏ СЂРѕРІРЅРѕ 64 С€РµСЃС‚РЅР°РґС†Р°С‚РµСЂРёС‡РЅС‹С… СЃРёРјРІРѕР»Р°."
    );
  }

  if (problems.length > 0) {
    throw new Error(
      "FORMA MARKETPLACE РЅРµ РјРѕР¶РµС‚ Р·Р°РїСѓСЃС‚РёС‚СЊСЃСЏ РІ production: " +
        problems.join(" ")
    );
  }
}

app.listen(PORT, () => {
  console.log(`FORMA MARKETPLACE Р·Р°РїСѓС‰РµРЅ РЅР° РїРѕСЂС‚Сѓ ${PORT}`);
});


