require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { all, get, run } = require("./src/db");
const session = require("express-session");

const app = express();
const PORT = 3000;
const SITE_AUDIO_SOURCE = "/audio/site-theme.mp3";
const PUBLIC_DIR = path.join(__dirname, "src", "public");
const PRODUCT_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "products");
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-later",
    resave: false,
    saveUninitialized: true,
  })
);
app.use((req, res, next) => {
  const cart = req.session.cart || [];
  res.locals.cartCount = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  res.locals.audioSource = SITE_AUDIO_SOURCE;
  // Admin stays fully server-rendered; the public site opts into the persistent shell.
  res.locals.isAdminRoute = req.path.startsWith("/admin");
  res.locals.usePublicShell = !res.locals.isAdminRoute;
  res.locals.showShellHeader = res.locals.usePublicShell && req.path !== "/";
  res.locals.showAudioPlayer = res.locals.showShellHeader;
  next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "src", "views"));

let ticketDetailsTableExistsPromise = null;
let productImagesTableExistsPromise = null;
const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const productImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, PRODUCT_UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
  },
});

const productImageUpload = multer({
  storage: productImageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, and WebP images are allowed."));
    }

    return cb(null, true);
  },
});

async function hasTicketDetailsTable() {
  if (!ticketDetailsTableExistsPromise) {
    ticketDetailsTableExistsPromise = get(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'ticket_details'`
    ).then((row) => Boolean(row));
  }

  return ticketDetailsTableExistsPromise;
}

async function hasProductImagesTable() {
  if (!productImagesTableExistsPromise) {
    productImagesTableExistsPromise = get(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'product_images'`
    ).then((row) => Boolean(row));
  }

  return productImagesTableExistsPromise;
}

function normalizeProductSlug(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function removeUploadedFiles(files = []) {
  for (const file of files) {
    if (!file?.path) continue;

    try {
      fs.unlinkSync(file.path);
    } catch (error) {
      console.error("Could not remove uploaded file:", file.path, error);
    }
  }
}

function normalizeAdminProductData(data = {}) {
  const initialVariants = Array.isArray(data.initial_variants)
    ? data.initial_variants.map((variant) => ({
        name: variant?.name || "",
        priceCents: variant?.priceCents || "",
        stockQty: variant?.stockQty || "",
      }))
    : [];

  return {
    id: data.id,
    name: data.name || "",
    slug: data.slug || "",
    type: data.type || "ticket",
    description: data.description || "",
    image_url: data.image_url || "",
    event_date: data.event_date || "",
    venue_name: data.venue_name || "",
    venue_city: data.venue_city || "",
    venue_state: data.venue_state || "",
    ticket_mode: data.ticket_mode || "internal",
    external_url: data.external_url || "",
    is_on_sale: Number(data.is_on_sale) === 0 ? 0 : 1,
    initial_variants: initialVariants.length > 0
      ? initialVariants
      : [{ name: "", priceCents: "", stockQty: "" }],
  };
}

async function loadAdminProduct(productId) {
  const ticketDetailsEnabled = await hasTicketDetailsTable();

  const product = ticketDetailsEnabled
    ? await get(
        `SELECT p.id, p.slug, p.name, p.type, p.description, p.image_url,
                td.event_date, td.venue_name, td.venue_city, td.venue_state,
                COALESCE(td.ticket_mode, 'internal') AS ticket_mode,
                td.external_url,
                COALESCE(td.is_on_sale, 1) AS is_on_sale
         FROM products p
         LEFT JOIN ticket_details td
           ON td.product_id = p.id
         WHERE p.id = ?`,
        [productId]
      )
    : await get(
        `SELECT id, slug, name, type, description, image_url,
                NULL AS event_date,
                NULL AS venue_name,
                NULL AS venue_city,
                NULL AS venue_state,
                'internal' AS ticket_mode,
                NULL AS external_url,
                1 AS is_on_sale
         FROM products
         WHERE id = ?`,
        [productId]
      );

  return product ? normalizeAdminProductData(product) : null;
}

async function loadProductVariants(productId) {
  return all(
    `SELECT id, name, price_cents, stock_qty, is_active
     FROM product_variants
     WHERE product_id = ?
     ORDER BY id ASC`,
    [productId]
  );
}

async function loadProductImages(productId, { activeOnly = false } = {}) {
  if (!(await hasProductImagesTable())) {
    return [];
  }

  const activeClause = activeOnly ? "AND pi.is_active = 1" : "";

  return all(
    `SELECT pi.id, pi.product_id, pi.variant_id, pi.image_path, pi.alt_text,
            pi.sort_order, pi.is_primary, pi.is_active, pi.created_at,
            v.name AS variant_name
     FROM product_images pi
     LEFT JOIN product_variants v
       ON v.id = pi.variant_id
     WHERE pi.product_id = ?
       ${activeClause}
     ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC`,
    [productId]
  );
}

async function loadAdminProductImages(productId) {
  return loadProductImages(productId);
}

function buildMerchImageViewModel(product, productImages = []) {
  const activeImages = productImages.filter((image) => Number(image.is_active) === 1);
  const productLevelImages = activeImages.filter((image) => !image.variant_id);
  const variantImages = activeImages.filter((image) => image.variant_id);
  const defaultImage =
    productLevelImages[0] ||
    activeImages[0] ||
    (product.image_url
      ? {
          id: null,
          variant_id: null,
          image_path: product.image_url,
          alt_text: product.name,
          sort_order: 0,
          is_primary: 1,
          is_active: 1,
        }
      : null);

  return {
    images: activeImages,
    productLevelImages,
    variantImages,
    defaultImage,
  };
}

async function loadStoreMerchItems() {
  const merch = await all(
    `SELECT id, slug, name, description, image_url
     FROM products
     WHERE type = 'merch' AND is_active = 1
     ORDER BY id DESC`
  );

  if (merch.length === 0) return [];
  if (!(await hasProductImagesTable())) {
    return merch.map((item) => ({
      ...item,
      display_image_url: item.image_url || "",
    }));
  }

  const imageRows = await all(
    `SELECT pi.id, pi.product_id, pi.image_path, pi.is_primary, pi.sort_order, pi.is_active
     FROM product_images pi
     JOIN products p ON p.id = pi.product_id
     WHERE p.type = 'merch' AND p.is_active = 1 AND pi.is_active = 1
     ORDER BY pi.product_id ASC, pi.is_primary DESC, pi.sort_order ASC, pi.id ASC`
  );

  const imageMap = new Map();
  for (const row of imageRows) {
    if (!imageMap.has(row.product_id)) {
      imageMap.set(row.product_id, row.image_path);
    }
  }

  return merch.map((item) => ({
    ...item,
    display_image_url: imageMap.get(item.id) || item.image_url || "",
  }));
}

function parseAdminProductInput(body = {}) {
  return normalizeAdminProductData({
    name: (body.name || "").trim(),
    slug: normalizeProductSlug(body.slug || ""),
    type: (body.type || "").trim(),
    description: (body.description || "").trim(),
    image_url: (body.imageUrl || "").trim(),
    event_date: (body.eventDate || "").trim(),
    venue_name: (body.venueName || "").trim(),
    venue_city: (body.venueCity || "").trim(),
    venue_state: (body.venueState || "").trim(),
    ticket_mode: (body.ticketMode || "").trim(),
    external_url: (body.externalUrl || "").trim(),
    is_on_sale: body.isOnSale ? 1 : 0,
  });
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [value];
}

function parseInitialVariants(body = {}) {
  const names = toArray(body.variantNames);
  const prices = toArray(body.variantPrices);
  const stocks = toArray(body.variantStocks);
  const rowCount = Math.max(names.length, prices.length, stocks.length);
  const variants = [];

  for (let i = 0; i < rowCount; i += 1) {
    variants.push({
      name: String(names[i] ?? "").trim(),
      priceCents: String(prices[i] ?? "").trim(),
      stockQty: String(stocks[i] ?? "").trim(),
    });
  }

  return variants;
}

function validateAdminProductInput(productData, options = {}) {
  const { ticketDetailsEnabled = true } = options;

  if (!productData.name || !["ticket", "merch"].includes(productData.type)) {
    return "Name, slug, and type are required.";
  }

  if (!productData.slug || !PRODUCT_SLUG_PATTERN.test(productData.slug)) {
    return "Slug must use lowercase letters, numbers, and hyphens only.";
  }

  if (productData.type === "ticket") {
    if (!ticketDetailsEnabled) {
      return "Ticket details table is missing. Reset the database before editing ticket metadata.";
    }

    if (
      !productData.event_date ||
      !productData.venue_name ||
      !productData.venue_city ||
      !productData.venue_state ||
      !["internal", "external", "doors_only", "free"].includes(productData.ticket_mode)
    ) {
      return "Ticket date, venue name, city, state, and ticket mode are required.";
    }

    if (productData.ticket_mode === "external" && !productData.external_url) {
      return "External URL is required for external ticket mode.";
    }
  }

  return null;
}

function validateInitialVariants(productData, initialVariants) {
  const requiresVariants =
    productData.type === "merch" ||
    (productData.type === "ticket" && productData.ticket_mode === "internal");

  const filledVariants = initialVariants.filter((variant) =>
    variant.name || variant.priceCents || variant.stockQty
  );

  if (!requiresVariants) {
    return { error: null, variants: [] };
  }

  if (filledVariants.length === 0) {
    return {
      error: "At least one initial variant is required.",
      variants: initialVariants,
    };
  }

  for (const variant of filledVariants) {
    const priceCents = Number(variant.priceCents);
    const stockQty = Number(variant.stockQty);

    if (!variant.name) {
      return {
        error: "Each initial variant must have a name.",
        variants: initialVariants,
      };
    }

    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      return {
        error: "Each initial variant price must be > 0 in cents.",
        variants: initialVariants,
      };
    }

    if (!Number.isInteger(stockQty) || stockQty < 0) {
      return {
        error: "Each initial variant stock quantity must be 0 or more.",
        variants: initialVariants,
      };
    }
  }

  return {
    error: null,
    variants: filledVariants.map((variant) => ({
      name: variant.name,
      priceCents: Number(variant.priceCents),
      stockQty: Number(variant.stockQty),
    })),
  };
}

function renderAdminNewProduct(res, { error = null, formData = {} } = {}) {
  res.render("pages/admin_new_product", {
    title: "New Product",
    error,
    formData: normalizeAdminProductData(formData),
  });
}

function renderAdminEditProduct(
  res,
  { error = null, product, variants, variantError = null, imageError = null, productImages = [] } = {}
) {
  res.render("pages/admin_edit_product", {
    title: "Edit Product",
    error,
    product: normalizeAdminProductData(product),
    variants,
    variantError,
    imageError,
    productImages,
  });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/admin/login");
}

// routes

// Home
app.get("/", (req, res) => {
  res.render("pages/intro", { title: "All Under Heaven" });
});

app.get("/home", (req, res) => {
  res.render("pages/home", { title: "All Under Heaven" });
});

app.get("/tickets", async (req, res) => {
  const ticketDetailsEnabled = await hasTicketDetailsTable();
  const tickets = ticketDetailsEnabled
    ? await all(
        `SELECT p.id, p.slug, p.name, p.description,
                td.event_date, td.venue_name, td.venue_city, td.venue_state,
                COALESCE(td.ticket_mode, 'internal') AS ticket_mode,
                td.external_url,
                COALESCE(td.is_on_sale, 1) AS is_on_sale,
                va.price_from_cents,
                COALESCE(va.active_variant_count, 0) AS active_variant_count
         FROM products p
         LEFT JOIN ticket_details td
           ON td.product_id = p.id
         LEFT JOIN (
           SELECT product_id,
                  MIN(price_cents) AS price_from_cents,
                  COUNT(*) AS active_variant_count
           FROM product_variants
           WHERE is_active = 1
           GROUP BY product_id
         ) va
           ON va.product_id = p.id
         WHERE p.type = 'ticket' AND p.is_active = 1
         ORDER BY p.id DESC`
      )
    : await all(
        `SELECT p.id, p.slug, p.name, p.description,
                NULL AS event_date,
                NULL AS venue_name,
                NULL AS venue_city,
                NULL AS venue_state,
                'internal' AS ticket_mode,
                NULL AS external_url,
                1 AS is_on_sale,
                va.price_from_cents,
                COALESCE(va.active_variant_count, 0) AS active_variant_count
         FROM products p
         LEFT JOIN (
           SELECT product_id,
                  MIN(price_cents) AS price_from_cents,
                  COUNT(*) AS active_variant_count
           FROM product_variants
           WHERE is_active = 1
           GROUP BY product_id
         ) va
           ON va.product_id = p.id
         WHERE p.type = 'ticket' AND p.is_active = 1
         ORDER BY p.id DESC`
      );

  res.render("pages/tickets", { title: "Tickets", items: tickets });
});

app.get("/store", async (req, res) => {
  const merch = await loadStoreMerchItems();
  res.render("pages/store", { title: "Store", items: merch });
});

app.get("/product/:slug", async (req, res) => {
  const { slug } = req.params;
  const ticketDetailsEnabled = await hasTicketDetailsTable();

  const product = ticketDetailsEnabled
    ? await get(
        `SELECT p.id, p.slug, p.name, p.type, p.description, p.image_url,
                td.event_date, td.venue_name, td.venue_city, td.venue_state,
                COALESCE(td.ticket_mode, 'internal') AS ticket_mode,
                td.external_url,
                COALESCE(td.is_on_sale, 1) AS is_on_sale
         FROM products p
         LEFT JOIN ticket_details td
           ON td.product_id = p.id
         WHERE p.slug = ? AND p.is_active = 1`,
        [slug]
      )
    : await get(
        `SELECT id, slug, name, type, description, image_url,
                NULL AS event_date,
                NULL AS venue_name,
                NULL AS venue_city,
                NULL AS venue_state,
                'internal' AS ticket_mode,
                NULL AS external_url,
                1 AS is_on_sale
         FROM products
         WHERE slug = ? AND is_active = 1`,
        [slug]
      );

  if (!product) return res.status(404).send("Product not found");

  const variants = await all(
    `SELECT id, name, price_cents, stock_qty
     FROM product_variants
     WHERE product_id = ? AND is_active = 1
     ORDER BY id ASC`,
    [product.id]
  );

  let merchImages = {
    images: [],
    productLevelImages: [],
    variantImages: [],
    defaultImage: product.image_url
      ? {
          id: null,
          variant_id: null,
          image_path: product.image_url,
          alt_text: product.name,
        }
      : null,
  };

  if (product.type === "merch") {
    const productImages = await loadProductImages(product.id, { activeOnly: true });
    merchImages = buildMerchImageViewModel(product, productImages);
  }

  res.render("pages/product", { title: product.name, product, variants, merchImages });
});

app.get("/music", (req, res) => {
  res.render("pages/music", { title: "Music" });
});

app.get("/newsletter", (req, res) => {
  res.render("pages/newsletter", { title: "Newsletter", status: null });
});

app.post("/newsletter", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();

  if (!email.includes("@") || !email.includes(".")) {
    return res.render("pages/newsletter", {
      title: "Newsletter",
      status: "Please enter a valid email.",
    });
  }

  try {
    await run(`INSERT INTO newsletter_signups (email) VALUES (?)`, [email]);
    return res.render("pages/newsletter", {
      title: "Newsletter",
      status: "Thanks! You’re signed up.",
    });
  } catch (err) {
    return res.render("pages/newsletter", {
      title: "Newsletter",
      status: "You’re already signed up.",
    });
  }
});

// cart

app.get("/cart", (req, res) => {
  const cart = req.session.cart || [];
  const subtotalCents = cart.reduce((sum, i) => sum + i.priceCents * i.qty, 0);

  res.render("pages/cart", {
    title: "Cart",
    cart,
    subtotalCents,
  });
});

app.get("/checkout", (req, res) => {
  const cart = req.session.cart || [];

  if (cart.length === 0) {
    return res.redirect("/cart");
  }

  const subtotalCents = cart.reduce((sum, i) => sum + i.priceCents * i.qty, 0);

  res.render("pages/checkout", {
    title: "Checkout",
    cart,
    subtotalCents,
  });
});

app.get("/checkout/success/:id", async (req, res) => {
  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).send("Invalid order id");
  }

  const order = await get(
    `SELECT id, order_number, customer_name, customer_email, status, subtotal_cents, created_at
     FROM orders
     WHERE id = ?`,
    [orderId]
  );

  if (!order) {
    return res.status(404).send("Order not found");
  }

  const items = await all(
    `SELECT id, product_type, product_slug_snapshot, product_name_snapshot,
            variant_name_snapshot, unit_price_cents, quantity, line_total_cents
     FROM order_items
     WHERE order_id = ?
     ORDER BY id ASC`,
    [orderId]
  );

  res.render("pages/checkout_success", {
    title: "Order Confirmed",
    order,
    items,
  });
});

app.post("/cart/add", async (req, res) => {
  const variantId = Number(req.body.variantId);
  const qty = Math.max(1, Number(req.body.qty || 1));

  if (!req.session.cart) req.session.cart = [];

  const row = await get(
    `SELECT v.id as variant_id, v.name as variant_name, v.price_cents, v.stock_qty,
            p.slug as product_slug, p.name as product_name, p.type as product_type
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.id = ? AND v.is_active = 1 AND p.is_active = 1`,
    [variantId]
  );

  if (!row) return res.status(400).send("Invalid variant");

  const existing = req.session.cart.find((i) => i.variantId === variantId);
  const currentQty = existing ? existing.qty : 0;

  if (currentQty + qty > row.stock_qty) {
    return res.status(400).send("Not enough stock");
  }

  if (existing) {
    existing.qty += qty;
  } else {
    req.session.cart.push({
      variantId: row.variant_id,
      qty,
      productName: row.product_name,
      productSlug: row.product_slug,
      productType: row.product_type,
      variantName: row.variant_name,
      priceCents: row.price_cents,
    });
  }

  res.redirect("/cart");
});

app.post("/cart/remove", (req, res) => {
  const index = Number(req.body.index);

  if (!req.session.cart) req.session.cart = [];

  if (index >= 0 && index < req.session.cart.length) {
    req.session.cart.splice(index, 1);
  }

  res.redirect("/cart");
});

function generateOrderNumber() {
  return `AUH-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

app.post("/checkout", async (req, res) => {
  const cart = req.session.cart || [];
  const customerName = (req.body.customerName || "").trim();
  const customerEmail = (req.body.customerEmail || "").trim().toLowerCase();

  if (cart.length === 0) {
    return res.status(400).send("Cart is empty");
  }

  if (!customerName || !customerEmail) {
    return res.status(400).send("Customer name and email are required");
  }

  if (!customerEmail.includes("@") || !customerEmail.includes(".")) {
    return res.status(400).send("Enter a valid email");
  }

  const variantIds = [...new Set(cart.map((item) => Number(item.variantId)).filter(Number.isFinite))];

  if (variantIds.length === 0) {
    return res.status(400).send("Cart contains invalid items");
  }

  const placeholders = variantIds.map(() => "?").join(", ");
  const dbItems = await all(
    `SELECT v.id AS variant_id,
            v.name AS variant_name,
            v.price_cents,
            v.stock_qty,
            v.is_active AS variant_is_active,
            p.id AS product_id,
            p.slug AS product_slug,
            p.name AS product_name,
            p.type AS product_type,
            p.is_active AS product_is_active
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.id IN (${placeholders})`,
    variantIds
  );

  if (dbItems.length !== variantIds.length) {
    return res.status(400).send("One or more cart items no longer exist");
  }

  const dbItemsByVariantId = new Map(dbItems.map((item) => [item.variant_id, item]));
  const orderItems = [];
  let subtotalCents = 0;

  for (const cartItem of cart) {
    const variantId = Number(cartItem.variantId);
    const qty = Number(cartItem.qty);
    const dbItem = dbItemsByVariantId.get(variantId);

    if (!dbItem || !Number.isInteger(qty) || qty <= 0) {
      return res.status(400).send("Cart contains invalid items");
    }

    if (!dbItem.product_is_active || !dbItem.variant_is_active) {
      return res.status(400).send(`Item is no longer available: ${dbItem?.product_name || "Unknown product"}`);
    }

    if (dbItem.stock_qty < qty) {
      return res.status(400).send(`Not enough stock for ${dbItem.product_name} (${dbItem.variant_name})`);
    }

    const lineTotalCents = dbItem.price_cents * qty;
    subtotalCents += lineTotalCents;

    orderItems.push({
      productId: dbItem.product_id,
      variantId: dbItem.variant_id,
      productType: dbItem.product_type,
      productSlugSnapshot: dbItem.product_slug,
      productNameSnapshot: dbItem.product_name,
      variantNameSnapshot: dbItem.variant_name,
      unitPriceCents: dbItem.price_cents,
      quantity: qty,
      lineTotalCents,
    });
  }

  const orderNumber = generateOrderNumber();

  try {
    await run("BEGIN IMMEDIATE TRANSACTION");

    const orderResult = await run(
      `INSERT INTO orders (
         order_number,
         customer_name,
         customer_email,
         subtotal_cents
       ) VALUES (?, ?, ?, ?)`,
      [orderNumber, customerName, customerEmail, subtotalCents]
    );

    const orderId = orderResult.lastID;

    for (const item of orderItems) {
      const stockUpdate = await run(
        `UPDATE product_variants
         SET stock_qty = stock_qty - ?
         WHERE id = ?
           AND is_active = 1
           AND stock_qty >= ?`,
        [item.quantity, item.variantId, item.quantity]
      );

      if (stockUpdate.changes !== 1) {
        throw new Error(`Inventory update failed for variant ${item.variantId}`);
      }

      await run(
        `INSERT INTO order_items (
           order_id,
           product_id,
           variant_id,
           product_type,
           product_slug_snapshot,
           product_name_snapshot,
           variant_name_snapshot,
           unit_price_cents,
           quantity,
           line_total_cents
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.productId,
          item.variantId,
          item.productType,
          item.productSlugSnapshot,
          item.productNameSnapshot,
          item.variantNameSnapshot,
          item.unitPriceCents,
          item.quantity,
          item.lineTotalCents,
        ]
      );
    }

    await run("COMMIT");
    req.session.cart = [];

    if (req.accepts("html")) {
      return res.redirect(`/checkout/success/${orderId}`);
    }

    return res.status(201).json({
      message: "Order placed",
      orderId,
      orderNumber,
      subtotalCents,
      itemCount: orderItems.length,
    });
  } catch (err) {
    try {
      await run("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Checkout rollback failed:", rollbackErr);
    }

    console.error("Checkout failed:", err);
    return res.status(500).send("Checkout failed");
  }
});


// admin 

app.get("/admin/login", (req, res) => {
  res.render("pages/admin_login", { title: "Admin Login", error: null });
});

app.post("/admin/login", (req, res) => {
  const pw = req.body.password || "";
  const expected = process.env.ADMIN_PASSWORD || "admin";

  if (pw === expected) {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }

  return res.render("pages/admin_login", {
    title: "Admin Login",
    error: "Wrong password.",
  });
});

app.post("/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  res.redirect("/");
});

app.get("/admin", requireAdmin, (req, res) => {
  res.render("pages/admin", { title: "Admin" });
});

app.get("/admin/orders", requireAdmin, async (req, res) => {
  const orders = await all(
    `SELECT id, order_number, customer_name, customer_email, subtotal_cents, status, created_at
     FROM orders
     ORDER BY created_at DESC, id DESC`
  );

  res.render("pages/admin_orders", { title: "Orders", orders });
});

app.get("/admin/orders/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).send("Invalid order id");
  }

  const order = await get(
    `SELECT id, order_number, customer_name, customer_email, subtotal_cents, status, created_at
     FROM orders
     WHERE id = ?`,
    [id]
  );

  if (!order) {
    return res.status(404).send("Order not found");
  }

  const items = await all(
    `SELECT id, product_type, product_slug_snapshot, product_name_snapshot,
            variant_name_snapshot, unit_price_cents, quantity, line_total_cents
     FROM order_items
     WHERE order_id = ?
     ORDER BY id ASC`,
    [id]
  );

  res.render("pages/admin_order_detail", {
    title: `Order ${order.order_number}`,
    order,
    items,
  });
});

app.get("/admin/newsletter", requireAdmin, async (req, res) => {
  const signups = await all(
    `SELECT id, email, created_at
     FROM newsletter_signups
     ORDER BY created_at DESC, id DESC`
  );

  res.render("pages/admin_newsletter", {
    title: "Newsletter Signups",
    signups,
  });
});

app.post("/admin/newsletter/:id/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).send("Invalid signup id");
  }

  const result = await run(`DELETE FROM newsletter_signups WHERE id = ?`, [id]);

  if (result.changes !== 1) {
    return res.status(404).send("Signup not found");
  }

  return res.redirect("/admin/newsletter");
});

app.get("/admin/products", requireAdmin, async (req, res) => {
  const products = await all(
    `SELECT id, slug, name, type, is_active, created_at
     FROM products
     ORDER BY created_at DESC`
  );
  res.render("pages/admin_products", { title: "Manage Products", products });
});

app.get("/admin/products/new", requireAdmin, (req, res) => {
  renderAdminNewProduct(res);
});

app.get("/admin/products/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).send("Invalid product id");
  }

  const product = await loadAdminProduct(id);

  if (!product) {
    return res.status(404).send("Product not found");
  }

  const variants = await loadProductVariants(id);
  const productImages = product.type === "merch" ? await loadAdminProductImages(id) : [];

  return renderAdminEditProduct(res, {
    product,
    variants,
    productImages,
  });
});

// product creation
app.post("/admin/products/new", requireAdmin, async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      productImageUpload.array("images", 10)(req, res, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    const formData = parseAdminProductInput(req.body);
    formData.initial_variants = parseInitialVariants(req.body);

    return renderAdminNewProduct(res, {
      error: error.message || "Could not upload product images.",
      formData,
    });
  }

  const uploadedFiles = req.files || [];
  const formData = parseAdminProductInput(req.body);
  const initialVariants = parseInitialVariants(req.body);
  formData.initial_variants = initialVariants;
  const ticketDetailsEnabled = await hasTicketDetailsTable();
  const validationError = validateAdminProductInput(formData, { ticketDetailsEnabled });
  const variantValidation = validateInitialVariants(formData, initialVariants);

  if (validationError) {
    removeUploadedFiles(uploadedFiles);
    return renderAdminNewProduct(res, {
      error: validationError,
      formData,
    });
  }

  if (variantValidation.error) {
    removeUploadedFiles(uploadedFiles);
    return renderAdminNewProduct(res, {
      error: variantValidation.error,
      formData,
    });
  }

  if (formData.type !== "merch" && uploadedFiles.length > 0) {
    removeUploadedFiles(uploadedFiles);
    return renderAdminNewProduct(res, {
      error: "Image uploads are only supported for merch products.",
      formData,
    });
  }

  if (formData.type === "merch" && uploadedFiles.length > 0 && !(await hasProductImagesTable())) {
    removeUploadedFiles(uploadedFiles);
    return renderAdminNewProduct(res, {
      error: "Product images table is missing. Reset the database first.",
      formData,
    });
  }

  try {
    await run("BEGIN IMMEDIATE TRANSACTION");

    const result = await run(
      `INSERT INTO products (slug, name, type, description, image_url)
       VALUES (?, ?, ?, ?, ?)`,
      [formData.slug, formData.name, formData.type, formData.description, formData.image_url]
    );

    const productId = result.lastID;

    if (formData.type === "ticket") {
      await run(
        `INSERT INTO ticket_details (
           product_id,
           event_date,
           venue_name,
           venue_city,
           venue_state,
           ticket_mode,
           external_url,
           is_on_sale
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          formData.event_date,
          formData.venue_name,
          formData.venue_city,
          formData.venue_state,
          formData.ticket_mode,
          formData.ticket_mode === "external" ? formData.external_url : null,
          formData.is_on_sale,
        ]
      );
    }

    // ✅ Always create ONE default variant so cart works for tickets + merch
    if (
      formData.type === "merch" ||
      (formData.type === "ticket" && formData.ticket_mode === "internal")
    ) {
      for (const variant of variantValidation.variants) {
        await run(
          `INSERT INTO product_variants (product_id, name, price_cents, stock_qty)
           VALUES (?, ?, ?, ?)`,
          [productId, variant.name, variant.priceCents, variant.stockQty]
        );
      }
    }

    if (formData.type === "merch" && uploadedFiles.length > 0) {
      for (const [index, file] of uploadedFiles.entries()) {
        await run(
          `INSERT INTO product_images (product_id, image_path, alt_text, sort_order, is_primary, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [
            productId,
            `/uploads/products/${file.filename}`,
            formData.name,
            index,
            index === 0 ? 1 : 0,
          ]
        );
      }
    }

    await run("COMMIT");

    return res.redirect("/admin/products");
  } catch (e) {
    removeUploadedFiles(uploadedFiles);

    try {
      await run("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Create product rollback failed:", rollbackErr);
    }

    return renderAdminNewProduct(res, {
      error: e && String(e.message || "").includes("UNIQUE constraint failed: products.slug")
        ? "Could not create product. Slug must be unique."
        : "Could not create product.",
      formData,
    });
  }
});

app.post("/admin/products/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const formData = parseAdminProductInput(req.body);
  const pricingData = parsePriceAndStock(req.body);
  const ticketDetailsEnabled = await hasTicketDetailsTable();
  formData.id = id;

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).send("Invalid product id");
  }

  const validationError = validateAdminProductInput(formData, pricingData, {
    ticketDetailsEnabled,
  });

  if (validationError) {
    const variants = await loadProductVariants(id);
    const productImages = formData.type === "merch" ? await loadAdminProductImages(id) : [];

    return renderAdminEditProduct(res, {
      error: validationError,
      product: formData,
      variants,
      productImages,
    });
  }

  try {
    await run("BEGIN IMMEDIATE TRANSACTION");

    const result = await run(
      `UPDATE products
       SET name = ?, slug = ?, type = ?, description = ?, image_url = ?
       WHERE id = ?`,
      [formData.name, formData.slug, formData.type, formData.description, formData.image_url, id]
    );

    if (result.changes !== 1) {
      await run("ROLLBACK");
      return res.status(404).send("Product not found");
    }

    if (formData.type === "ticket") {
      await run(
        `INSERT INTO ticket_details (
           product_id,
           event_date,
           venue_name,
           venue_city,
           venue_state,
           ticket_mode,
           external_url,
           is_on_sale
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           event_date = excluded.event_date,
           venue_name = excluded.venue_name,
           venue_city = excluded.venue_city,
           venue_state = excluded.venue_state,
           ticket_mode = excluded.ticket_mode,
           external_url = excluded.external_url,
           is_on_sale = excluded.is_on_sale`,
        [
          id,
          formData.event_date,
          formData.venue_name,
          formData.venue_city,
          formData.venue_state,
          formData.ticket_mode,
          formData.ticket_mode === "external" ? formData.external_url : null,
          formData.is_on_sale,
        ]
      );
    } else if (ticketDetailsEnabled) {
      await run(`DELETE FROM ticket_details WHERE product_id = ?`, [id]);
    }

    await run("COMMIT");

    return res.redirect("/admin/products");
  } catch (e) {
    try {
      await run("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Edit product rollback failed:", rollbackErr);
    }

    const variants = await loadProductVariants(id);
    const productImages = formData.type === "merch" ? await loadAdminProductImages(id) : [];

    return renderAdminEditProduct(res, {
      error: e && String(e.message || "").includes("UNIQUE constraint failed: products.slug")
        ? "Could not update product. Slug must be unique."
        : "Could not update product.",
      product: formData,
      variants,
      productImages,
    });
  }
});

app.post(
  "/admin/products/:id/images/upload",
  requireAdmin,
  async (req, res) => {
    const productId = Number(req.params.id);

    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).send("Invalid product id");
    }

    const product = await loadAdminProduct(productId);

    if (!product) {
      return res.status(404).send("Product not found");
    }

    if (product.type !== "merch") {
      return res.status(400).send("Images can only be uploaded for merch products");
    }

    if (!(await hasProductImagesTable())) {
      return res.status(400).send("Product images table is missing. Reset the database first.");
    }

    try {
      await new Promise((resolve, reject) => {
        productImageUpload.array("images", 10)(req, res, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      const variants = await loadProductVariants(productId);
      const productImages = await loadAdminProductImages(productId);
      return renderAdminEditProduct(res, {
        product,
        variants,
        productImages,
        imageError: error.message || "Could not upload product images.",
      });
    }

    if (!req.files || req.files.length === 0) {
      const variants = await loadProductVariants(productId);
      const productImages = await loadAdminProductImages(productId);
      return renderAdminEditProduct(res, {
        product,
        variants,
        productImages,
        imageError: "Select at least one image to upload.",
      });
    }

    try {
      for (const file of req.files) {
        await run(
          `INSERT INTO product_images (product_id, image_path, alt_text, sort_order, is_primary, is_active)
           VALUES (?, ?, ?, 0, 0, 1)`,
          [productId, `/uploads/products/${file.filename}`, product.name]
        );
      }

      return res.redirect(`/admin/products/${productId}/edit`);
    } catch (error) {
      const variants = await loadProductVariants(productId);
      const productImages = await loadAdminProductImages(productId);
      return renderAdminEditProduct(res, {
        product,
        variants,
        productImages,
        imageError: "Could not upload product images.",
      });
    }
  }
);

app.post("/admin/products/:id/images/:imageId/update", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const imageId = Number(req.params.imageId);
  const altText = (req.body.altText || "").trim();
  const sortOrder = Number(req.body.sortOrder || 0);
  const isActive = req.body.isActive ? 1 : 0;
  const isPrimary = req.body.isPrimary ? 1 : 0;
  const variantIdValue = (req.body.variantId || "").trim();
  const variantId = variantIdValue ? Number(variantIdValue) : null;

  if (
    !Number.isInteger(productId) ||
    productId <= 0 ||
    !Number.isInteger(imageId) ||
    imageId <= 0 ||
    !Number.isInteger(sortOrder)
  ) {
    return res.status(400).send("Invalid image update");
  }

  const product = await loadAdminProduct(productId);
  if (!product) {
    return res.status(404).send("Product not found");
  }

  if (product.type !== "merch") {
    return res.status(400).send("Images can only be managed for merch products");
  }

  if (!(await hasProductImagesTable())) {
    return res.status(400).send("Product images table is missing. Reset the database first.");
  }

  const image = await get(
    `SELECT id, product_id
     FROM product_images
     WHERE id = ? AND product_id = ?`,
    [imageId, productId]
  );

  if (!image) {
    return res.status(404).send("Image not found");
  }

  if (variantId !== null) {
    if (!Number.isInteger(variantId) || variantId <= 0) {
      return res.status(400).send("Invalid variant id");
    }

    const variant = await get(
      `SELECT id
       FROM product_variants
       WHERE id = ? AND product_id = ?`,
      [variantId, productId]
    );

    if (!variant) {
      return res.status(400).send("Variant does not belong to this product");
    }
  }

  try {
    await run("BEGIN IMMEDIATE TRANSACTION");

    if (isPrimary) {
      await run(`UPDATE product_images SET is_primary = 0 WHERE product_id = ?`, [productId]);
    }

    await run(
      `UPDATE product_images
       SET alt_text = ?, sort_order = ?, is_active = ?, variant_id = ?, is_primary = ?
       WHERE id = ? AND product_id = ?`,
      [altText, sortOrder, isActive, variantId, isPrimary, imageId, productId]
    );

    await run("COMMIT");
    return res.redirect(`/admin/products/${productId}/edit`);
  } catch (error) {
    try {
      await run("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Image update rollback failed:", rollbackErr);
    }

    const variants = await loadProductVariants(productId);
    const productImages = await loadAdminProductImages(productId);
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      imageError: "Could not update image settings.",
    });
  }
});

app.post("/admin/products/:id/images/:imageId/delete", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const imageId = Number(req.params.imageId);

  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(imageId) || imageId <= 0) {
    return res.status(400).send("Invalid image id");
  }

  const product = await loadAdminProduct(productId);
  if (!product) {
    return res.status(404).send("Product not found");
  }

  if (!(await hasProductImagesTable())) {
    return res.status(400).send("Product images table is missing. Reset the database first.");
  }

  const result = await run(
    `DELETE FROM product_images
     WHERE id = ? AND product_id = ?`,
    [imageId, productId]
  );

  if (result.changes !== 1) {
    return res.status(404).send("Image not found");
  }

  return res.redirect(`/admin/products/${productId}/edit`);
});

app.post("/admin/products/:id/variants/new", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const name = (req.body.name || "").trim();
  const priceCents = Number(req.body.priceCents || 0);
  const stockQty = Number(req.body.stockQty || 0);

  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).send("Invalid product id");
  }

  const product = await loadAdminProduct(productId);

  if (!product) {
    return res.status(404).send("Product not found");
  }

  const variants = await loadProductVariants(productId);
  const productImages = product.type === "merch" ? await loadAdminProductImages(productId) : [];

  if (!name) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Variant name is required.",
    });
  }

  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Price must be > 0 in cents (example: 2500 for $25.00).",
    });
  }

  if (!Number.isInteger(stockQty) || stockQty < 0) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Stock quantity must be 0 or more.",
    });
  }

  try {
    await run(
      `INSERT INTO product_variants (product_id, name, price_cents, stock_qty, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [productId, name, priceCents, stockQty]
    );

    return res.redirect(`/admin/products/${productId}/edit`);
  } catch (e) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Could not create variant.",
    });
  }
});

app.post("/admin/products/:id/variants/:variantId/edit", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const variantId = Number(req.params.variantId);
  const name = (req.body.name || "").trim();
  const priceCents = Number(req.body.priceCents || 0);
  const stockQty = Number(req.body.stockQty || 0);

  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(variantId) || variantId <= 0) {
    return res.status(400).send("Invalid id");
  }

  const product = await loadAdminProduct(productId);

  if (!product) {
    return res.status(404).send("Product not found");
  }

  const variants = await loadProductVariants(productId);
  const productImages = product.type === "merch" ? await loadAdminProductImages(productId) : [];

  if (!variants.find((variant) => variant.id === variantId)) {
    return res.status(404).send("Variant not found");
  }

  if (!name) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Variant name is required.",
    });
  }

  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Price must be > 0 in cents (example: 2500 for $25.00).",
    });
  }

  if (!Number.isInteger(stockQty) || stockQty < 0) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Stock quantity must be 0 or more.",
    });
  }

  try {
    const result = await run(
      `UPDATE product_variants
       SET name = ?, price_cents = ?, stock_qty = ?
       WHERE id = ? AND product_id = ?`,
      [name, priceCents, stockQty, variantId, productId]
    );

    if (result.changes !== 1) {
      return res.status(404).send("Variant not found");
    }

    return res.redirect(`/admin/products/${productId}/edit`);
  } catch (e) {
    return renderAdminEditProduct(res, {
      product,
      variants,
      productImages,
      variantError: "Could not update variant.",
    });
  }
});

app.post("/admin/products/:id/variants/:variantId/toggle", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const variantId = Number(req.params.variantId);

  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(variantId) || variantId <= 0) {
    return res.status(400).send("Invalid id");
  }

  const result = await run(
    `UPDATE product_variants
     SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
     WHERE id = ? AND product_id = ?`,
    [variantId, productId]
  );

  if (result.changes !== 1) {
    return res.status(404).send("Variant not found");
  }

  return res.redirect(`/admin/products/${productId}/edit`);
});

app.post("/admin/products/:id/toggle", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).send("Invalid product id");
  }

  const result = await run(
    `UPDATE products
     SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
     WHERE id = ?`,
    [id]
  );

  if (result.changes !== 1) {
    return res.status(404).send("Product not found");
  }

  res.redirect("/admin/products");
});

// server start
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
