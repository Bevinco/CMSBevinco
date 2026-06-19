import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

const sculptureBaseUrl =
  process.env.SCULPTURE_BASE_URL || "https://beta.food.sculpturehospitality.com";
const defaultCid = process.env.SCULPTURE_DEFAULT_CID || "29088";
const defaultPid = process.env.SCULPTURE_DEFAULT_PID || "36";
const authUsername = process.env.CMS_AUTH_USERNAME;
const authPassword = process.env.CMS_AUTH_PASSWORD;
const sessionSecret = process.env.CMS_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessionCookieName = "bevinco_session";
const dataDir = path.resolve(__dirname, "../data");
const moduleStorePath = path.join(dataDir, "module1.json");
const publicDir = path.resolve(__dirname, "public");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sampleDefinitions = [
  {
    client: {
      id: "bardot-barra",
      name: "Bardot Barra",
      cid: "bardot-barra",
      area: "Beverage",
      recipients: ["operaciones@bardot.cl"],
    },
    varianceFile: "Bardot barra-Detailed Variance Report for Jun 4 to Jun 10 2026.csv",
    inteliparFile: "Bardot barra - inteliPar Report for Jun 4 to Jun 10 2026.csv",
  },
  {
    client: {
      id: "bardot-cocina",
      name: "Bardot Cocina",
      cid: "bardot-cocina",
      area: "Food",
      recipients: ["operaciones@bardot.cl"],
    },
    varianceFile: "Bardot cocina-Detailed Variance Report for Jun 4 to Jun 10 2026.csv",
    inteliparFile: "Bardot cocina - inteliPar Report for Jun 4 to Jun 10 2026.csv",
  },
];

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) return cookies;
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
    return cookies;
  }, {});
}

function signPayload(payload) {
  return crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function createSessionToken(username) {
  const payload = Buffer.from(
    JSON.stringify({
      username,
      expiresAt: Date.now() + 1000 * 60 * 60 * 12,
    }),
  ).toString("base64url");

  return `${payload}.${signPayload(payload)}`;
}

function readSession(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[sessionCookieName];
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature || !timingSafeEqual(signature, signPayload(payload))) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.expiresAt || session.expiresAt < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function requireAuth(request, response, next) {
  const session = readSession(request);
  if (!session) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  request.session = session;
  next();
}

function normalizeHeader(value) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase())
    .replace(/^[A-Z]/, (char) => char.toLowerCase());
}

function parseSculptureTable(html) {
  const $ = cheerio.load(html);
  const table = $("table").first();
  const headers = table
    .find("thead th")
    .map((_, element) => $(element).text().trim().replace(/\s+/g, " "))
    .get();

  const rows = [];
  let currentGroup = "";

  table.find("tbody tr, tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((__, cell) => $(cell).text().trim().replace(/\s+/g, " "))
      .get();

    if (!cells.length) return;

    const filledCells = cells.filter(Boolean);
    if (filledCells.length === 1 && cells.length < headers.length) {
      currentGroup = filledCells[0];
      return;
    }

    const record = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[normalizeHeader(header)] = cells[index] || "";
    });

    rows.push({
      group: currentGroup,
      values: cells,
      record,
    });
  });

  return { headers, rows };
}

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(moduleStorePath);
  } catch {
    const sampleStore = await buildStoreFromSamples();
    await fs.writeFile(moduleStorePath, JSON.stringify(sampleStore, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(moduleStorePath, "utf8");
  return JSON.parse(raw);
}

async function writeStore(store) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(moduleStorePath, JSON.stringify(store, null, 2));
}

function findReport(store, reportId) {
  return store.reports.find((report) => report.id === reportId);
}

function lastFourPeriods(store, selectedPeriodId) {
  const selectedIndex = store.periods.findIndex((period) => period.id === selectedPeriodId);
  if (selectedIndex === -1) return store.periods.slice(0, 4);
  return store.periods.slice(selectedIndex, selectedIndex + 4);
}

function historyForReport(store, report) {
  const periods = lastFourPeriods(store, report.periodId);
  return periods.map((period, index) => {
    const existing = store.reports.find(
      (candidate) => candidate.clientId === report.clientId && candidate.periodId === period.id,
    );

    return {
      periodId: period.id,
      label: period.label,
      revenue: existing?.summary?.revenue || Math.round((report.summary.revenue || 0) * (1 - index * 0.04)),
      costPercent: existing?.summary?.costPercent || Number((report.summary.costPercent + index * 0.7).toFixed(1)),
      varianceAmount:
        existing?.summary?.varianceAmount || Math.round((report.summary.varianceAmount || 0) * (1 - index * 0.18)),
    };
  });
}

function parseNumber(value) {
  let normalized = String(value || "")
    .replace(/[$,%]/g, "")
    .replace(/\s/g, "")
    .trim();

  const isNegative = normalized.startsWith("-") || normalized.startsWith("(");
  normalized = normalized.replace(/[()+-]/g, "");

  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/,/g, "");
  } else if (normalized.includes(",") && !normalized.includes(".")) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return isNegative ? -parsed : parsed;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);

  const [headers = [], ...body] = rows;
  return body.map((values) =>
    headers.reduce((record, header, index) => {
      record[header.trim()] = (values[index] || "").trim();
      return record;
    }, {}),
  );
}

async function readSampleCsv(fileName) {
  const filePath = path.join(publicDir, fileName);
  const content = await fs.readFile(filePath, "utf8");
  return parseCsv(content);
}

function isTotalRow(name) {
  return /^Total\s.+:$/i.test(name || "");
}

function cleanTotalName(name) {
  return String(name || "")
    .replace(/^Total\s+/i, "")
    .replace(/:$/, "")
    .trim();
}

function currentCategoryFromTotal(name, fallback) {
  if (!isTotalRow(name)) return fallback;
  return cleanTotalName(name);
}

function buildCategoryVariances(varianceRows) {
  return varianceRows
    .filter((row) => isTotalRow(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]))
    .map((row) => ({
      category: cleanTotalName(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]),
      amount: parseNumber(row["Diferencia (Costo)"]),
      percent: parseNumber(row["% Diferencia"]),
    }))
    .filter((row) => row.amount || row.percent)
    .slice(0, 10);
}

function buildTopProducts(varianceRows) {
  let category = "Sin categoria";

  return varianceRows
    .map((row) => {
      const name = row["Nombre Artículo"] || row["Nombre ArtÃ­culo"] || "";
      if (isTotalRow(name)) {
        category = currentCategoryFromTotal(name, category);
        return null;
      }

      return {
        name,
        category,
        varianceAmount: parseNumber(row["Diferencia (Costo)"]),
        variancePercent: parseNumber(row["% Diferencia"]),
      };
    })
    .filter(Boolean)
    .filter((row) => row.name && (row.varianceAmount || row.variancePercent))
    .sort((left, right) => Math.abs(right.varianceAmount) - Math.abs(left.varianceAmount))
    .slice(0, 10);
}

function buildPurchaseSuggestions(inteliparRows) {
  return inteliparRows
    .filter((row) => !isTotalRow(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]))
    .map((row) => {
      const order = row["Orden"] || row["Compras realizadas"] || "";
      const provider = row["Proveedor"] || "Por validar";
      const excess = row["Exceso de Inventario"] || "";
      const daysRemaining = row["Días Restantes"] || row["DÃ­as Restantes"] || "";

      return {
        item: row["Nombre Artículo"] || row["Nombre ArtÃ­culo"] || "",
        provider,
        stock: row["Existencia"] || "",
        suggested: order,
        note: excess
          ? `Exceso ${excess}${daysRemaining ? `, ${daysRemaining} dias restantes` : ""}`
          : "Validar proveedor y sugerencia antes del envio",
      };
    })
    .filter((row) => row.item && (row.suggested || row.stock))
    .slice(0, 12);
}

function buildSummary(varianceRows) {
  const productRows = varianceRows.filter((row) => !isTotalRow(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]));
  const revenue = productRows.reduce((total, row) => total + parseNumber(row["Ingresos"]), 0);
  const usedCost = productRows.reduce((total, row) => total + parseNumber(row["Usado (Costo)"]), 0);
  const soldCost = productRows.reduce((total, row) => total + parseNumber(row["Vendido (Costo)"]), 0);
  const varianceAmount = productRows.reduce((total, row) => total + parseNumber(row["Diferencia (Costo)"]), 0);

  return {
    revenue,
    costPercent: revenue ? Number(((usedCost / revenue) * 100).toFixed(1)) : 0,
    variancePercent: soldCost ? Number(((varianceAmount / soldCost) * 100).toFixed(1)) : 0,
    varianceAmount,
  };
}

function commentsForReport(clientName, report) {
  const direction = report.summary.varianceAmount < 0 ? "faltantes" : "sobrantes";
  const biggestCategory = report.categoryVariances[0]?.category || "las categorias principales";

  return `${clientName} presenta un costo de ${report.summary.costPercent}% para el periodo, con una diferencia acumulada de ${moneyPlain(report.summary.varianceAmount)} asociada principalmente a ${biggestCategory}. Revisar los productos con mayor variacion y validar la sugerencia de compra antes del envio al cliente, especialmente proveedores marcados como por validar.`;
}

function moneyPlain(value) {
  return new Intl.NumberFormat("es-CL", {
    currency: "CLP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value || 0);
}

async function buildStoreFromSamples() {
  const period = {
    id: "jun-04-10-2026",
    label: "Jun 4 to Jun 10 2026",
    startsAt: "2026-06-04",
    endsAt: "2026-06-10",
  };
  const clients = sampleDefinitions.map((sample) => sample.client);
  const reports = [];

  for (const sample of sampleDefinitions) {
    try {
      const varianceRows = await readSampleCsv(sample.varianceFile);
      const inteliparRows = await readSampleCsv(sample.inteliparFile);
      const report = {
        id: `${sample.client.id}-${period.id}`,
        clientId: sample.client.id,
        periodId: period.id,
        status: "Borrador",
        updatedAt: new Date().toISOString(),
        summary: buildSummary(varianceRows),
        categoryVariances: buildCategoryVariances(varianceRows),
        topProducts: buildTopProducts(varianceRows),
        purchaseSuggestions: buildPurchaseSuggestions(inteliparRows),
        comments: "",
        emailDraft:
          "Hola, adjuntamos el reporte semanal de auditoria. En el resumen se destacan las principales variaciones, productos a revisar y sugerencias de compra para el siguiente periodo.",
        sourceStatus: {
          varianceDetailed: "CSV muestra",
          varianceSummary: "Pendiente endpoint",
          intelipar: "CSV muestra",
        },
      };
      report.comments = commentsForReport(sample.client.name, report);
      reports.push(report);
    } catch (error) {
      console.warn(`Could not load sample files for ${sample.client.name}: ${error.message}`);
    }
  }

  return {
    clients,
    periods: [
      period,
      { id: "may-28-jun-03-2026", label: "May 28 to Jun 3 2026", startsAt: "2026-05-28", endsAt: "2026-06-03" },
      { id: "may-21-27-2026", label: "May 21 to May 27 2026", startsAt: "2026-05-21", endsAt: "2026-05-27" },
      { id: "may-14-20-2026", label: "May 14 to May 20 2026", startsAt: "2026-05-14", endsAt: "2026-05-20" },
    ],
    reports,
  };
}

function extractReportMetrics(parsedTable) {
  const rows = parsedTable.rows || [];
  const categoryMap = new Map();
  const products = [];

  rows.forEach((row) => {
    const values = row.values || [];
    const itemName = row.record.itemName || values[0] || "";
    const category = row.group || row.record.category || "Sin categoria";
    const varianceValue =
      row.record.variance ||
      row.record.varianceAmount ||
      row.record.difference ||
      row.record.extendedDifference ||
      values.find((value) => String(value).includes("%")) ||
      values[values.length - 1] ||
      "0";
    const amount = parseNumber(varianceValue);

    if (itemName) {
      products.push({
        name: itemName,
        category,
        varianceAmount: amount,
        variancePercent: parseNumber(values.find((value) => String(value).includes("%"))),
      });
    }

    categoryMap.set(category, (categoryMap.get(category) || 0) + amount);
  });

  const categoryVariances = Array.from(categoryMap.entries()).map(([category, amount]) => ({
    category,
    amount,
    percent: 0,
  }));

  return {
    categoryVariances: categoryVariances.slice(0, 8),
    topProducts: products
      .sort((left, right) => Math.abs(right.varianceAmount) - Math.abs(left.varianceAmount))
      .slice(0, 8),
  };
}

function reportForClientPeriod(store, clientId, periodId) {
  let report = store.reports.find(
    (candidate) => candidate.clientId === clientId && candidate.periodId === periodId,
  );

  if (!report) {
    report = {
      id: `${clientId}-${periodId}`,
      clientId,
      periodId,
      status: "Borrador",
      updatedAt: new Date().toISOString(),
      summary: {
        revenue: 0,
        costPercent: 0,
        variancePercent: 0,
        varianceAmount: 0,
      },
      categoryVariances: [],
      topProducts: [],
      purchaseSuggestions: [],
      comments: "",
      emailDraft: "",
      sourceStatus: {
        varianceDetailed: "Pendiente",
        varianceSummary: "Pendiente",
        intelipar: "Pendiente",
      },
    };
    store.reports.unshift(report);
  }

  return report;
}

async function fetchSculptureInternalReport({ type, cid, pid }) {
  const cookie = process.env.SCULPTURE_SESSION_COOKIE;
  if (!cookie) {
    const error = new Error("SCULPTURE_SESSION_COOKIE is not configured.");
    error.status = 503;
    throw error;
  }

  const reportConfig = {
    varianceDetailed: {
      path: process.env.SCULPTURE_VARIANCE_DETAILED_PATH || "/reports/variance/",
      payload: {
        cmd: process.env.SCULPTURE_VARIANCE_DETAILED_CMD || "variance",
        view: "detailed",
        cid,
        pid,
      },
    },
    varianceSummary: {
      path: process.env.SCULPTURE_VARIANCE_SUMMARY_PATH || "/reports/variance/",
      payload: {
        cmd: process.env.SCULPTURE_VARIANCE_SUMMARY_CMD || "variance",
        view: "summary",
        cid,
        pid,
      },
    },
    intelipar: {
      path: process.env.SCULPTURE_INTELIPAR_PATH || "/reports/intelipar/",
      payload: {
        cmd: process.env.SCULPTURE_INTELIPAR_CMD || "overview",
        cid,
        pid,
      },
    },
  }[type];

  if (!reportConfig) {
    const error = new Error("Unsupported report type.");
    error.status = 400;
    throw error;
  }

  const body = new URLSearchParams(reportConfig.payload);
  const response = await fetch(`${sculptureBaseUrl}${reportConfig.path}`, {
    method: "POST",
    headers: {
      accept: "text/html, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      cookie,
      origin: sculptureBaseUrl,
      referer: `${sculptureBaseUrl}/`,
      "x-requested-with": "XMLHttpRequest",
    },
    body,
  });

  const html = await response.text();
  if (!response.ok) {
    const error = new Error(`Sculpture returned ${response.status} for ${type}.`);
    error.status = response.status;
    error.details = html.slice(0, 500);
    throw error;
  }

  return {
    type,
    endpoint: reportConfig.path,
    cid,
    pid,
    ...parseSculptureTable(html),
  };
}

function buildReportPayload(store, report) {
  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const period = store.periods.find((candidate) => candidate.id === report.periodId);

  return {
    ...report,
    client,
    period,
    history: historyForReport(store, report),
  };
}

function renderReportHtml(store, report) {
  const payload = buildReportPayload(store, report);
  const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

  const categoryRows = payload.categoryVariances
    .map(
      (item) =>
        `<tr><td>${item.category}</td><td>${money.format(item.amount)}</td><td>${item.percent}%</td></tr>`,
    )
    .join("");
  const productRows = payload.topProducts
    .map(
      (item) =>
        `<tr><td>${item.name}</td><td>${item.category}</td><td>${money.format(item.varianceAmount)}</td><td>${item.variancePercent}%</td></tr>`,
    )
    .join("");
  const purchaseRows = payload.purchaseSuggestions
    .map(
      (item) =>
        `<tr><td>${item.item}</td><td>${item.provider}</td><td>${item.stock}</td><td>${item.suggested}</td><td>${item.note}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Reporte ${payload.client?.name || report.clientId}</title>
  <style>
    body { color: #172026; font-family: Arial, sans-serif; margin: 32px; }
    header { border-bottom: 3px solid #176b5a; margin-bottom: 24px; padding-bottom: 16px; }
    h1, h2 { margin: 0 0 10px; }
    section { margin: 24px 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #dce4e2; padding: 10px; text-align: left; }
    th { background: #f4f6f5; }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .metric { border: 1px solid #dce4e2; border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 22px; margin-top: 8px; }
    .comments { background: #f4f6f5; border-radius: 8px; padding: 16px; white-space: pre-wrap; }
    @media print { button { display: none; } body { margin: 18mm; } }
  </style>
</head>
<body>
  <button onclick="window.print()">Guardar como PDF</button>
  <header>
    <h1>Reporte semanal Bevinco</h1>
    <p>${payload.client?.name || report.clientId} - ${payload.period?.label || report.periodId}</p>
  </header>
  <section class="metrics">
    <div class="metric">Ingresos<strong>${money.format(payload.summary.revenue)}</strong></div>
    <div class="metric">% Costo<strong>${payload.summary.costPercent}%</strong></div>
    <div class="metric">Variance<strong>${payload.summary.variancePercent}%</strong></div>
    <div class="metric">Diferencia<strong>${money.format(payload.summary.varianceAmount)}</strong></div>
  </section>
  <section><h2>Comentarios</h2><div class="comments">${payload.comments || ""}</div></section>
  <section><h2>Variaciones por categoria</h2><table><thead><tr><th>Categoria</th><th>Monto</th><th>%</th></tr></thead><tbody>${categoryRows}</tbody></table></section>
  <section><h2>Top productos</h2><table><thead><tr><th>Producto</th><th>Categoria</th><th>Monto</th><th>%</th></tr></thead><tbody>${productRows}</tbody></table></section>
  <section><h2>Sugerencia de compra</h2><table><thead><tr><th>Item</th><th>Proveedor</th><th>Stock</th><th>Sugerido</th><th>Nota</th></tr></thead><tbody>${purchaseRows}</tbody></table></section>
</body>
</html>`;
}

async function fetchRequisition({ cid, pid }) {
  const cookie = process.env.SCULPTURE_SESSION_COOKIE;

  if (!cookie) {
    const error = new Error("SCULPTURE_SESSION_COOKIE is not configured.");
    error.status = 503;
    throw error;
  }

  const body = new URLSearchParams({
    cmd: "overview",
    cid,
    pid,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${sculptureBaseUrl}/requisition/overview/`, {
      method: "POST",
      headers: {
        accept: "text/html, */*; q=0.01",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie,
        origin: sculptureBaseUrl,
        referer: `${sculptureBaseUrl}/requisition/`,
        "x-requested-with": "XMLHttpRequest",
      },
      body,
      signal: controller.signal,
    });

    const html = await response.text();

    if (!response.ok) {
      const error = new Error(`Sculpture returned ${response.status}.`);
      error.status = response.status;
      error.details = html.slice(0, 500);
      throw error;
    }

    return {
      source: "sculpture",
      endpoint: "/requisition/overview/",
      cid,
      pid,
      ...parseSculptureTable(html),
    };
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/auth/me", (request, response) => {
  const session = readSession(request);
  response.json({
    authenticated: Boolean(session),
    user: session ? { username: session.username } : null,
  });
});

app.post("/api/auth/login", (request, response) => {
  if (!authUsername || !authPassword) {
    response.status(503).json({ error: "CMS login is not configured." });
    return;
  }

  const { username, password } = request.body || {};

  if (!timingSafeEqual(username, authUsername) || !timingSafeEqual(password, authPassword)) {
    response.status(401).json({ error: "Usuario o contrasena incorrectos." });
    return;
  }

  response.setHeader("Set-Cookie", sessionCookie(createSessionToken(username)));
  response.json({ authenticated: true, user: { username } });
});

app.post("/api/auth/logout", (_request, response) => {
  response.setHeader("Set-Cookie", clearSessionCookie());
  response.json({ authenticated: false });
});

app.get("/api/sculpture/requisition", requireAuth, async (request, response) => {
  try {
    const cid = String(request.query.cid || defaultCid);
    const pid = String(request.query.pid || defaultPid);
    const data = await fetchRequisition({ cid, pid });
    response.json(data);
  } catch (error) {
    const status = error.status || 500;
    response.status(status).json({
      error: error.message || "Unable to fetch Sculpture requisition data.",
      details: error.details,
    });
  }
});

app.get("/api/module1/bootstrap", requireAuth, async (_request, response) => {
  const store = await readStore();
  const report = store.reports[0];
  response.json({
    clients: store.clients,
    periods: store.periods,
    reports: store.reports.map((item) => buildReportPayload(store, item)),
    selectedReport: report ? buildReportPayload(store, report) : null,
  });
});

app.post("/api/module1/import-samples", requireAuth, async (_request, response) => {
  const sampleStore = await buildStoreFromSamples();
  await writeStore(sampleStore);
  const report = sampleStore.reports[0];
  response.json({
    clients: sampleStore.clients,
    periods: sampleStore.periods,
    reports: sampleStore.reports.map((item) => buildReportPayload(sampleStore, item)),
    selectedReport: report ? buildReportPayload(sampleStore, report) : null,
  });
});

app.get("/api/module1/reports/current", requireAuth, async (request, response) => {
  const store = await readStore();
  const clientId = String(request.query.clientId || store.clients[0]?.id || "");
  const periodId = String(request.query.periodId || store.periods[0]?.id || "");
  const report = reportForClientPeriod(store, clientId, periodId);
  await writeStore(store);
  response.json(buildReportPayload(store, report));
});

app.post("/api/module1/sync", requireAuth, async (request, response) => {
  const store = await readStore();
  const { clientId, periodId } = request.body || {};
  const client = store.clients.find((candidate) => candidate.id === clientId);

  if (!client) {
    response.status(404).json({ error: "Client not found." });
    return;
  }

  const report = reportForClientPeriod(store, clientId, periodId);
  const syncResults = {};

  for (const type of ["varianceDetailed", "varianceSummary", "intelipar"]) {
    try {
      const data = await fetchSculptureInternalReport({ type, cid: client.cid, pid: periodId });
      syncResults[type] = data;
      report.sourceStatus[type] = "Sincronizado";

      if (type === "varianceDetailed" || type === "varianceSummary") {
        const metrics = extractReportMetrics(data);
        if (metrics.categoryVariances.length) report.categoryVariances = metrics.categoryVariances;
        if (metrics.topProducts.length) report.topProducts = metrics.topProducts;
      }

      if (type === "intelipar") {
        report.purchaseSuggestions = data.rows.slice(0, 12).map((row) => ({
          item: row.record.itemName || row.values[0] || "",
          provider: row.record.provider || row.record.vendor || row.values[1] || "Por validar",
          stock: row.record.stock || row.record.onHand || row.values[2] || "",
          suggested: row.record.suggested || row.record.order || row.values[3] || "",
          note: "Revisar contra proveedor actualizado",
        }));
      }
    } catch (error) {
      syncResults[type] = {
        error: error.message,
        details: error.details,
      };
      report.sourceStatus[type] = "Pendiente endpoint";
    }
  }

  report.updatedAt = new Date().toISOString();
  await writeStore(store);

  response.json({
    report: buildReportPayload(store, report),
    syncResults,
  });
});

app.patch("/api/module1/reports/:reportId", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).json({ error: "Report not found." });
    return;
  }

  const allowedFields = ["status", "comments", "emailDraft", "summary", "categoryVariances", "topProducts", "purchaseSuggestions"];
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(request.body, field)) {
      report[field] = request.body[field];
    }
  });

  report.updatedAt = new Date().toISOString();
  await writeStore(store);
  response.json(buildReportPayload(store, report));
});

app.get("/api/module1/reports/:reportId/export", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).send("Report not found.");
    return;
  }

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.send(renderReportHtml(store, report));
});

app.post("/api/module1/reports/:reportId/email", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).json({ error: "Report not found." });
    return;
  }

  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const recipients = request.body?.recipients || client?.recipients || [];

  if (!process.env.RESEND_API_KEY) {
    response.json({
      prepared: true,
      sent: false,
      message: "RESEND_API_KEY is not configured. Email draft is ready but was not sent.",
      recipients,
      subject: `Reporte semanal Bevinco - ${client?.name || report.clientId}`,
      body: report.emailDraft,
    });
    return;
  }

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.REPORTS_FROM_EMAIL || "reportes@bevinco.local",
      to: recipients,
      subject: `Reporte semanal Bevinco - ${client?.name || report.clientId}`,
      html: renderReportHtml(store, report),
    }),
  });

  const payload = await resendResponse.json();
  if (!resendResponse.ok) {
    response.status(resendResponse.status).json(payload);
    return;
  }

  report.status = "Enviado";
  report.updatedAt = new Date().toISOString();
  await writeStore(store);
  response.json({ sent: true, payload, report: buildReportPayload(store, report) });
});

const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distPath, "index.html"));
});

app.listen(port, () => {
  console.log(`Bevinco CMS listening on port ${port}`);
});
