
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const crypto = require("crypto");
const multer = require("multer");
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

// Доверяем только явно заданным HTTPS reverse proxy адресам в production.
// Прокси должен перезаписывать X-Forwarded-* заголовки от внешнего клиента.
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
        "TRUST_PROXY_IPS должен содержать корректные адреса доверенного HTTPS-прокси."
      );
    }
  }
}

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "20kb"
}));

// Сессии пользователей
const sessionSecret =
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");

if (!process.env.SESSION_SECRET) {
  console.warn(
    "ВНИМАНИЕ: временный ключ сессий. " +
    "Для публикации задайте SESSION_SECRET."
  );
}

// Ограничение попыток входа: 5 запросов за 15 минут с одного IP.
// Действует для входа продавца, администратора и покупателя.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Слишком много попыток входа. Попробуйте позже через 15 минут."
  },
  standardHeaders: true,
  legacyHeaders: false,
});


let sessionStore;

if (process.env.DATABASE_URL) {
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

// Папка фотографий
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// Настройка загрузки фотографий
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp"
    }[file.mimetype];

    cb(null, crypto.randomUUID() + (ext || ".bin"));
  }
});

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
      return cb(new Error("Недопустимый формат фотографии."));
    }

    cb(null, true);
  }
});

// Проверка входа
async function requireLogin(req, res, next) {
  if (!req.session.companyId) {
    return res.status(401).json({
      success: false,
      message: "Сначала войдите в аккаунт."
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
        message: "Аккаунт не найден."
      });
    }

    if (company.is_blocked === 1) {
      req.session.destroy(() => {});
      return res.status(403).json({
        success: false,
        message: "Ваш аккаунт заблокирован."
      });
    }

    next();
  } catch (error) {
    console.error("Ошибка проверки аккаунта:", error);

    return res.status(500).json({
      success: false,
      message: "Ошибка проверки доступа."
    });
  }
}

// Protect the admin document before the public static middleware can serve it.
app.use(createAdminPageGuard(
  db,
  path.join(__dirname, "public", "admin.html")
));

// Страницы сайта
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

// Регистрация компании
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
        message: "Для регистрации необходимо принять соглашение о комиссии версии 1.0."
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
        message: "Проверьте поля. Пароль: от 8 до 128 символов."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Введите правильную почту."
      });
    }

    const existing = await db.prepare(
      "SELECT id FROM companies WHERE email = ?"
    ).get(normalizedEmail);

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Такая почта уже зарегистрирована."
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
      message: "Компания успешно зарегистрирована!"
    });
  } catch (error) {
    console.error("Ошибка регистрации:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Такая почта уже зарегистрирована."
      });
    }

    res.status(500).json({
      success: false,
      message: "Ошибка сервера."
    });
  }
});

// Вход в аккаунт
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
        message: "Введите почту и пароль."
      });
    }

    const company = await db.prepare(
      "SELECT * FROM companies WHERE email = ?"
    ).get(email.trim().toLowerCase());

    if (!company) {
      return res.status(401).json({
        success: false,
        message: "Неверная почта или пароль."
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      company.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Неверная почта или пароль."
      });
    }

    if (company.is_blocked === 1) {
      return res.status(403).json({
        success: false,
        message: "Ваш аккаунт заблокирован. Обратитесь к администрации FORMA."
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error("Ошибка сессии:", error);
        return res.status(500).json({
          success: false,
          message: "Ошибка входа."
        });
      }

      req.session.companyId = String(company.id);

      req.session.save((error) => {
        if (error) {
          console.error("Ошибка сохранения сессии:", error);
          return res.status(500).json({
            success: false,
            message: "Ошибка входа."
          });
        }

        res.json({
          success: true,
          message: "Вход выполнен успешно!",
          company: {
            id: company.id,
            name: company.company_name,
            city: company.city
          }
        });
      });
    });
  } catch (error) {
    console.error("Ошибка входа:", error);
    res.status(500).json({
      success: false,
      message: "Ошибка сервера."
    });
  }
});

// Данные компании
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
      message: "Аккаунт не найден."
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
        message: "Укажите адрес склада от 5 до 300 символов"
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
        message: "Компания не найдена"
      });
    }

    return res.json({
      success: true,
      message: "Адрес склада успешно сохранён!",
      pickup_address: normalizedAddress
    });

  } catch (error) {
    console.error("Ошибка сохранения адреса склада:", error);

    return res.status(500).json({
      success: false,
      message: "Ошибка сервера"
    });
  }
});

// Публикация мебели
app.post(
  "/api/products",
  requireLogin,
  upload.single("photo"),
  async (req, res) => {
    try {
      const { name, category, price, description } = req.body;

      const categories = [
  "Кухни",
  "Шкафы",
  "Диваны",
  "Кровати",
  "Столы",
  "Другая мебель"
];

      const priceNumber = Number(price);

      // Характеристики упаковки для доставки
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
            throw new Error("Некорректное значение: " + field);
          }

          return value;
        });
      } catch (error) {
        if (req.file) {
          fs.unlinkSync(req.file.path);
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
          fs.unlinkSync(req.file.path);
        }

        return res.status(400).json({
          success: false,
          message: "Проверьте название, категорию, цену, описание и фотографию."
        });
      }

      // Проверяем сигнатуру изображения
      const bytes = Buffer.alloc(12);
      const fd = fs.openSync(req.file.path, "r");
      try {
        fs.readSync(fd, bytes, 0, 12, 0);
      } finally {
        fs.closeSync(fd);
      }

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
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
          success: false,
          message: "Файл не является допустимой фотографией."
        });
      }

      const company = await db.prepare(
        "SELECT id FROM companies WHERE id = ?"
      ).get(req.session.companyId);

      if (!company) {
        fs.unlinkSync(req.file.path);
        return res.status(401).json({
          success: false,
          message: "Аккаунт не найден."
        });
      }

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
        req.file.filename,
        ...deliveryValues
      );

      res.status(201).json({
        success: true,
        message: "Товар успешно опубликован!",
        productId: result.lastInsertRowid.toString()
      });
    } catch (error) {
      console.error("Ошибка публикации:", error);

      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }

      res.status(500).json({
        success: false,
        message: "Не удалось сохранить товар."
      });
    }
  }
);

// Список товаров
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
        photoUrl: "/uploads/" + product.photo
      }))
    });
  } catch (error) {
    console.error("Ошибка получения товаров:", error);

    res.status(500).json({
      success: false,
      message: "Не удалось загрузить товары."
    });
  }
});

// Показываем фотографии
app.use("/uploads", express.static(uploadsDir));

// Выход из аккаунта
app.post("/logout", async (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Не удалось выйти."
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true,
      message: "Вы вышли из аккаунта."
    });
  });
});

// Ошибки загрузки фотографий
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Фотография не должна превышать 5 МБ."
        : "Ошибка загрузки фотографии."
    });
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Ошибка запроса."
    });
  }

  next();
});

// Запуск сервера
app.put("/api/products/:id", requireLogin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, category, price, description } = req.body;

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Неверный ID товара"
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
        message: "Заполните все поля правильно"
      });
    }

    const product = await db.prepare(`
      SELECT id, weight_kg, length_cm, width_cm, height_cm FROM products
      WHERE id = ? AND company_id = ?
    `).get(id, req.session.companyId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Товар не найден"
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
          message: "Некорректное значение: " + field
        });
      }

      const value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0 || value > 100000) {
        return res.status(400).json({
          success: false,
          message: "Некорректное значение: " + field
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
      message: "Товар успешно обновлён"
    });

  } catch (error) {
    console.error("Ошибка редактирования:", error);

    res.status(500).json({
      success: false,
      message: "Ошибка обновления товара"
    });
  }
});

app.delete("/api/products/:id", requireLogin, async (req, res) => {



  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Неверный ID товара"
      });
    }

    const product = await db.prepare(`
      SELECT id FROM products
      WHERE id = ? AND company_id = ?
    `).get(id, req.session.companyId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Товар не найден"
      });
    }

    await db.prepare(`
      DELETE FROM products
      WHERE id = ? AND company_id = ?
    `).run(id, req.session.companyId);

    res.json({
      success: true,
      message: "Товар удалён"
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Ошибка удаления товара"
    });
  }
});


app.put("/api/products/:id/photo", requireLogin, upload.single("photo"), async (req, res) => {
  const removeUploadedFile = () => {
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
  };

  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      removeUploadedFile();
      return res.status(400).json({
        success: false,
        message: "Неверный ID товара"
      });
    }

    const product = await db.prepare(
      "SELECT id, photo FROM products WHERE id = ? AND company_id = ?"
    ).get(id, req.session.companyId);

    if (!product) {
      removeUploadedFile();
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

    await db.prepare(
      "UPDATE products SET photo = ? WHERE id = ? AND company_id = ?"
    ).run(req.file.filename, id, req.session.companyId);

    return res.json({
      success: true,
      message: "Фотография обновлена"
    });
  } catch (error) {
    removeUploadedFile();
    console.error("Ошибка обновления фотографии:", error);

    return res.status(500).json({
      success: false,
      message: "Ошибка обновления фотографии"
    });
  }
});



/* FORMA MARKETPLACE — расценки продавцов */

// Получить расценки своей компании
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
    console.error("Ошибка получения расценок:", error);

    res.status(500).json({
      success: false,
      message: "Не удалось получить расценки"
    });
  }
});

// Сохранить расценки своей компании
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
        message: "Введите корректные цены в тенге"
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
      message: "Расценки сохранены"
    });

  } catch (error) {
    console.error("Ошибка сохранения расценок:", error);

    res.status(500).json({
      success: false,
      message: "Не удалось сохранить расценки"
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

// Production pre-flight: запрет запуска с демонстрационной доставкой,
// небезопасным SESSION_SECRET или битой настройкой YANDEX_KEYS_SECRET.
// Значения секретов в ошибках не выводятся.
if (process.env.NODE_ENV === "production") {
  const problems = [];

  if (
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32
  ) {
    problems.push(
      "SESSION_SECRET не задан или слишком короткий (минимум 32 символа)."
    );
  }

  if (process.env.ENABLE_DEMO_DELIVERY === "true") {
    problems.push(
      "ENABLE_DEMO_DELIVERY=true: демонстрационная доставка не разрешена в production."
    );
  }

  if (
    process.env.YANDEX_KEYS_SECRET !== undefined &&
    !/^[0-9a-f]{64}$/i.test(process.env.YANDEX_KEYS_SECRET)
  ) {
    problems.push(
      "YANDEX_KEYS_SECRET задан неверно: ожидается ровно 64 шестнадцатеричных символа."
    );
  }

  if (problems.length > 0) {
    throw new Error(
      "FORMA MARKETPLACE не может запуститься в production: " +
        problems.join(" ")
    );
  }
}

app.listen(PORT, () => {
  console.log(`FORMA MARKETPLACE запущен на порту ${PORT}`);
});

