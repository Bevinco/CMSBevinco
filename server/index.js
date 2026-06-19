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

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

app.use((error, _request, response, next) => {
  if (error?.type === "entity.too.large") {
    response.status(413).json({
      error: "El archivo es demasiado grande para cargarlo. Usa un CSV descargado desde Sculpture o divide la carga.",
    });
    return;
  }

  next(error);
});

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

const sourceLabelsForPdf = {
  varianceDetailed: "Variance detailed",
  varianceSummary: "Variance summary",
  intelipar: "Intelipar",
};

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

function topByAbsoluteValue(items, field, limit = 3) {
  return [...(items || [])]
    .sort((left, right) => Math.abs(right[field] || 0) - Math.abs(left[field] || 0))
    .slice(0, limit);
}

function generateReportSummary(store, report) {
  const payload = buildReportPayload(store, report);
  const clientName = payload.client?.name || report.clientId;
  const periodLabel = payload.period?.label || report.periodId;
  const summary = payload.summary || {};
  const categories = topByAbsoluteValue(payload.categoryVariances, "amount", 3);
  const products = topByAbsoluteValue(payload.topProducts, "varianceAmount", 4);
  const purchaseItems = (payload.purchaseSuggestions || [])
    .filter((item) => item.suggested || item.note)
    .slice(0, 5);
  const missingProviders = (payload.purchaseSuggestions || [])
    .filter((item) => /validar|por validar/i.test(`${item.provider} ${item.note}`))
    .slice(0, 4);
  const varianceTone = (summary.varianceAmount || 0) < 0 ? "faltantes" : "sobrantes";
  const categoryText = categories.length
    ? categories.map((item) => `${item.category} (${moneyPlain(item.amount)}, ${item.percent}%)`).join(", ")
    : "sin categorias con variacion relevante";
  const productText = products.length
    ? products.map((item) => `${item.name} en ${item.category} (${moneyPlain(item.varianceAmount)}, ${item.variancePercent}%)`).join("; ")
    : "sin productos con diferencias relevantes";
  const purchaseText = purchaseItems.length
    ? purchaseItems.map((item) => `${item.item}: sugerido ${item.suggested || "por revisar"}, stock ${item.stock || "s/i"}, proveedor ${item.provider || "por validar"}`).join("; ")
    : "sin sugerencias de compra relevantes";
  const providerText = missingProviders.length
    ? `Validar proveedor o dato de compra en: ${missingProviders.map((item) => item.item).join(", ")}.`
    : "No se detectan proveedores marcados para validacion prioritaria.";

  return [
    `Resumen ejecutivo ${clientName} - ${periodLabel}`,
    "",
    `El periodo registra ingresos por ${moneyPlain(summary.revenue)} y un costo de ${summary.costPercent || 0}%. La diferencia acumulada es ${moneyPlain(summary.varianceAmount)} (${summary.variancePercent || 0}%), asociada principalmente a ${varianceTone} o diferencias operativas que deben revisarse antes del envio.`,
    "",
    `Categorias con mayor impacto: ${categoryText}.`,
    "",
    `Productos a revisar: ${productText}.`,
    "",
    `Sugerencia de compra Intelipar: ${purchaseText}. ${providerText}`,
    "",
    "Recomendacion: revisar los productos con mayor variacion, confirmar proveedores sugeridos y validar si las diferencias corresponden a merma, registro de venta, compra no actualizada o ajuste operativo.",
  ].join("\n");
}

function generateReportAnalysis(payload) {
  const money = new Intl.NumberFormat("es-CL", {
    currency: "CLP",
    maximumFractionDigits: 0,
    style: "currency",
  });
  const bestProducts = (payload.topProducts || [])
    .filter((item) => item.varianceAmount > 0)
    .sort((left, right) => right.varianceAmount - left.varianceAmount)
    .slice(0, 3);
  const challengeProducts = (payload.topProducts || [])
    .filter((item) => item.varianceAmount < 0)
    .sort((left, right) => Math.abs(right.varianceAmount) - Math.abs(left.varianceAmount))
    .slice(0, 4);
  const challengeCategories = (payload.categoryVariances || [])
    .filter((item) => item.amount < 0)
    .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))
    .slice(0, 3);
  const purchaseItems = (payload.purchaseSuggestions || [])
    .filter((item) => parseNumber(item.suggested) > 0 || /exceso|validar/i.test(`${item.note} ${item.provider}`))
    .slice(0, 4);

  return {
    bestOfWeek: bestProducts.map(
      (item) =>
        `En ${item.name} (${item.category}) se observa un ahorro o diferencia positiva de ${money.format(item.varianceAmount)} (${item.variancePercent}%), aportando al resultado semanal.`,
    ),
    weeklyChallenges: [
      ...challengeCategories.map(
        (item) =>
          `En la categoria ${item.category} se concentra una diferencia negativa de ${money.format(item.amount)} (${item.percent}%), por lo que conviene revisar inventario, merma y registro de ventas.`,
      ),
      ...challengeProducts.map(
        (item) =>
          `${item.name} presenta una diferencia de ${money.format(item.varianceAmount)} (${item.variancePercent}%) dentro de ${item.category}; revisar conteo, consumo y posibles ajustes operativos.`,
      ),
    ].slice(0, 5),
    stockEfficiency: purchaseItems.map(
      (item) =>
        `${item.item}: stock ${item.stock || "s/i"}, compra sugerida ${item.suggested || "por revisar"}, proveedor ${item.provider || "por validar"}. ${item.note || ""}`.trim(),
    ),
    agentNotes: (payload.comments || "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .slice(0, 5),
  };
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
        analysis: null,
        comments: "",
        emailDraft:
          "Hola, adjuntamos el reporte semanal de auditoria. En el resumen se destacan las principales variaciones, productos a revisar y sugerencias de compra para el siguiente periodo.",
        sourceStatus: {
          varianceDetailed: "Datos cargados",
          varianceSummary: "Por revisar",
          intelipar: "Datos cargados",
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
      analysis: null,
      comments: "",
      emailDraft: "",
      sourceStatus: {
        varianceDetailed: "Por revisar",
        varianceSummary: "Por revisar",
        intelipar: "Por revisar",
      },
    };
    store.reports.unshift(report);
  }

  return report;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureClient(store, clientInput) {
  const id = clientInput.id || slugify(clientInput.name);
  let client = store.clients.find((candidate) => candidate.id === id);

  if (!client) {
    client = {
      id,
      name: clientInput.name || id,
      cid: clientInput.cid || id,
      area: clientInput.area || "Food",
      recipients: clientInput.recipients || [],
    };
    store.clients.push(client);
  } else {
    Object.assign(client, {
      name: clientInput.name || client.name,
      cid: clientInput.cid || client.cid,
      area: clientInput.area || client.area,
      recipients: clientInput.recipients || client.recipients,
    });
  }

  return client;
}

function ensurePeriod(store, periodInput) {
  const id = periodInput.id || slugify(periodInput.label);
  let period = store.periods.find((candidate) => candidate.id === id);

  if (!period) {
    period = {
      id,
      label: periodInput.label || id,
      startsAt: periodInput.startsAt || "",
      endsAt: periodInput.endsAt || "",
    };
    store.periods.push(period);
  } else {
    Object.assign(period, {
      label: periodInput.label || period.label,
      startsAt: periodInput.startsAt || period.startsAt,
      endsAt: periodInput.endsAt || period.endsAt,
    });
  }

  return period;
}

function applyCsvToReport(report, sourceType, rows) {
  if (sourceType === "varianceDetailed" || sourceType === "varianceSummary") {
    report.summary = buildSummary(rows);
    report.categoryVariances = buildCategoryVariances(rows);
    report.topProducts = buildTopProducts(rows);
  }

  if (sourceType === "intelipar") {
    report.purchaseSuggestions = buildPurchaseSuggestions(rows);
  }

  report.sourceStatus[sourceType] = "Datos cargados";
  report.updatedAt = new Date().toISOString();
}

function detectCsvSourceType(rows, fileName = "") {
  const headers = Object.keys(rows[0] || {}).join(" ").toLowerCase();
  const name = String(fileName).toLowerCase();

  if (
    name.includes("intelipar") ||
    headers.includes("orden") ||
    headers.includes("proveedor") ||
    headers.includes("par") ||
    headers.includes("exceso de inventario")
  ) {
    return "intelipar";
  }

  if (
    name.includes("variance") ||
    headers.includes("diferencia") ||
    headers.includes("vendido") ||
    headers.includes("porcentaje de costo") ||
    headers.includes("costo de alimentos")
  ) {
    return "varianceDetailed";
  }

  return "varianceDetailed";
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

  const payload = {
    ...report,
    client,
    period,
    history: historyForReport(store, report),
  };
  payload.analysis = report.analysis || generateReportAnalysis(payload);

  return payload;
}

function renderReportHtml(store, report) {
  const payload = buildReportPayload(store, report);
  const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const generatedAt = new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
  const statusClassName = payload.status === "Enviado" ? "ok" : payload.status === "Listo para revisar" ? "warn" : "neutral";
  const varianceClassName = payload.summary.varianceAmount < 0 ? "bad" : "ok";

  const categoryRows = payload.categoryVariances
    .map(
      (item) =>
        `<tr><td>${item.category}</td><td class="numeric ${item.amount < 0 ? "bad" : "ok"}">${money.format(item.amount)}</td><td class="numeric">${item.percent}%</td></tr>`,
    )
    .join("");
  const productRows = payload.topProducts
    .map(
      (item) =>
        `<tr><td><strong>${item.name}</strong></td><td>${item.category}</td><td class="numeric ${item.varianceAmount < 0 ? "bad" : "ok"}">${money.format(item.varianceAmount)}</td><td class="numeric">${item.variancePercent}%</td></tr>`,
    )
    .join("");
  const purchaseRows = payload.purchaseSuggestions
    .map(
      (item) =>
        `<tr><td><strong>${item.item}</strong></td><td>${item.provider}</td><td class="numeric">${item.stock}</td><td class="numeric">${item.suggested}</td><td>${item.note}</td></tr>`,
    )
    .join("");
  const historyRows = payload.history
    .map(
      (item) =>
        `<tr><td>${item.label}</td><td class="numeric">${money.format(item.revenue)}</td><td class="numeric">${item.costPercent}%</td><td class="numeric ${item.varianceAmount < 0 ? "bad" : "ok"}">${money.format(item.varianceAmount)}</td></tr>`,
    )
    .join("");
  const sourceRows = Object.entries(payload.sourceStatus || {})
    .map(([source, status]) => `<tr><td>${sourceLabelsForPdf[source] || source}</td><td><span class="badge neutral">${status}</span></td></tr>`)
    .join("");
  const maxCategoryVariance = Math.max(...payload.categoryVariances.map((item) => Math.abs(item.amount)), 1);
  const maxProductVariance = Math.max(...payload.topProducts.map((item) => Math.abs(item.varianceAmount)), 1);
  const maxHistoryRevenue = Math.max(...payload.history.map((item) => item.revenue), 1);
  const categoryChart = payload.categoryVariances
    .slice(0, 8)
    .map((item) => {
      const width = Math.max(8, (Math.abs(item.amount) / maxCategoryVariance) * 100);
      const tone = item.amount < 0 ? "bar negative" : "bar positive";
      return `<div class="chart-row"><div class="chart-label"><strong>${item.category}</strong><span class="${item.amount < 0 ? "bad" : "ok"}">${money.format(item.amount)} · ${item.percent}%</span></div><div class="chart-track"><div class="${tone}" style="width:${width}%"></div></div></div>`;
    })
    .join("");
  const productChart = payload.topProducts
    .slice(0, 8)
    .map((item) => {
      const width = Math.max(8, (Math.abs(item.varianceAmount) / maxProductVariance) * 100);
      const tone = item.varianceAmount < 0 ? "bar negative" : "bar positive";
      return `<div class="chart-row"><div class="chart-label"><strong>${item.name}</strong><span>${item.category}</span><span class="${item.varianceAmount < 0 ? "bad" : "ok"}">${money.format(item.varianceAmount)} · ${item.variancePercent}%</span></div><div class="chart-track"><div class="${tone}" style="width:${width}%"></div></div></div>`;
    })
    .join("");
  const historyChart = payload.history
    .map((item) => {
      const width = Math.max(8, (item.revenue / maxHistoryRevenue) * 100);
      return `<div class="chart-row"><div class="chart-label"><strong>${item.label}</strong><span>${money.format(item.revenue)} · ${item.costPercent}% costo</span></div><div class="chart-track"><div class="bar positive" style="width:${width}%"></div></div></div>`;
    })
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reporte ${payload.client?.name || report.clientId}</title>
  <style>
    @page { margin: 14mm; size: A4; }
    * { box-sizing: border-box; }
    body {
      background: #eef3f1;
      color: #172026;
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.42;
      margin: 0;
      padding: 24px;
    }
    .report {
      background: #ffffff;
      border: 1px solid #d8e2df;
      margin: 0 auto;
      max-width: 1100px;
      min-height: 100vh;
    }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin: 0 auto 14px;
      max-width: 1100px;
    }
    button {
      background: #176b5a;
      border: 0;
      border-radius: 8px;
      color: #ffffff;
      cursor: pointer;
      font-weight: 700;
      min-height: 40px;
      padding: 0 14px;
    }
    header {
      background: #10201d;
      color: #ffffff;
      padding: 28px 32px;
    }
    .brand-row {
      align-items: center;
      display: flex;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 28px;
    }
    .brand {
      align-items: center;
      display: flex;
      gap: 12px;
    }
    .brand-mark {
      align-items: center;
      background: #f4b84a;
      border-radius: 8px;
      color: #10201d;
      display: flex;
      font-size: 20px;
      font-weight: 800;
      height: 42px;
      justify-content: center;
      width: 42px;
    }
    .meta {
      color: #b9c9c4;
      font-size: 12px;
      text-align: right;
    }
    h1 {
      font-size: 34px;
      line-height: 1.05;
      margin: 0 0 10px;
    }
    h2 {
      font-size: 18px;
      margin: 0;
    }
    .subtitle {
      color: #dce8e4;
      margin: 0;
    }
    .content {
      display: grid;
      gap: 22px;
      padding: 26px 32px 34px;
    }
    .metrics {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(4, 1fr);
    }
    .metric {
      background: #f6f8f7;
      border: 1px solid #dce4e2;
      border-radius: 8px;
      padding: 14px;
    }
    .metric span {
      color: #526862;
      display: block;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .metric strong {
      display: block;
      font-size: 22px;
      margin-top: 8px;
    }
    .section {
      border: 1px solid #dce4e2;
      border-radius: 8px;
      overflow: hidden;
      page-break-inside: avoid;
    }
    .section-header {
      align-items: center;
      background: #f6f8f7;
      border-bottom: 1px solid #dce4e2;
      display: flex;
      justify-content: space-between;
      padding: 14px 16px;
    }
    .section-body {
      padding: 16px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border-bottom: 1px solid #e8eeee;
      font-size: 12px;
      padding: 9px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #fbfcfc;
      color: #526862;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
    }
    tbody tr:nth-child(even) td {
      background: #fbfcfc;
    }
    .numeric {
      text-align: right;
      white-space: nowrap;
    }
    .comments {
      background: #f6f8f7;
      border-left: 4px solid #176b5a;
      border-radius: 8px;
      font-size: 14px;
      padding: 16px;
      white-space: pre-wrap;
    }
    .chart-list {
      display: grid;
      gap: 12px;
    }
    .chart-row {
      display: grid;
      gap: 8px;
    }
    .chart-label {
      align-items: baseline;
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
      justify-content: space-between;
    }
    .chart-label span {
      color: #526862;
      font-size: 11px;
      font-weight: 700;
    }
    .chart-track {
      background: #edf1f0;
      border-radius: 999px;
      height: 10px;
      overflow: hidden;
    }
    .bar {
      border-radius: inherit;
      height: 100%;
    }
    .bar.positive {
      background: #176b5a;
    }
    .bar.negative {
      background: #d66b58;
    }
    .badge {
      border-radius: 999px;
      display: inline-flex;
      font-size: 11px;
      font-weight: 800;
      padding: 5px 9px;
    }
    .badge.ok, .ok { color: #14633f; }
    .badge.warn { background: #fff0c7; color: #825a00; }
    .badge.neutral { background: #edf1f0; color: #46605a; }
    .badge.ok { background: #dff5ea; }
    .bad { color: #9b2d22; }
    .two-col {
      display: grid;
      gap: 18px;
      grid-template-columns: 0.85fr 1.15fr;
    }
    footer {
      border-top: 1px solid #dce4e2;
      color: #6f7d79;
      font-size: 11px;
      padding: 16px 32px 24px;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .toolbar { display: none; }
      .report { border: 0; max-width: none; }
      header { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .section { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Guardar como PDF</button></div>
  <article class="report">
    <header>
      <div class="brand-row">
        <div class="brand"><div class="brand-mark">B</div><div><strong>Bevinco</strong><br><span>Reporte semanal de auditoria</span></div></div>
        <div class="meta">Generado ${generatedAt}<br>Estado <span class="badge ${statusClassName}">${payload.status}</span></div>
      </div>
      <h1>${payload.client?.name || report.clientId}</h1>
      <p class="subtitle">${payload.period?.label || report.periodId} · ${payload.client?.area || ""}</p>
    </header>
    <main class="content">
      <section class="metrics">
        <div class="metric"><span>Ingresos</span><strong>${money.format(payload.summary.revenue)}</strong></div>
        <div class="metric"><span>% costo</span><strong>${payload.summary.costPercent}%</strong></div>
        <div class="metric"><span>Variance</span><strong>${payload.summary.variancePercent}%</strong></div>
        <div class="metric"><span>Diferencia</span><strong class="${varianceClassName}">${money.format(payload.summary.varianceAmount)}</strong></div>
      </section>
      <section class="section">
        <div class="section-header"><h2>Comentarios ejecutivos</h2></div>
        <div class="section-body"><div class="comments">${payload.comments || ""}</div></div>
      </section>
      <section class="two-col">
        <div class="section">
          <div class="section-header"><h2>Fuentes</h2></div>
          <div class="section-body"><table><thead><tr><th>Fuente</th><th>Estado</th></tr></thead><tbody>${sourceRows}</tbody></table></div>
        </div>
        <div class="section">
          <div class="section-header"><h2>Historico ultimos 4 periodos</h2></div>
          <div class="section-body"><div class="chart-list">${historyChart}</div><table><thead><tr><th>Periodo</th><th>Ingresos</th><th>% Costo</th><th>Variance</th></tr></thead><tbody>${historyRows}</tbody></table></div>
        </div>
      </section>
      <section class="section">
        <div class="section-header"><h2>Variaciones por categoria</h2></div>
        <div class="section-body"><div class="chart-list">${categoryChart}</div><table><thead><tr><th>Categoria</th><th>Monto</th><th>%</th></tr></thead><tbody>${categoryRows}</tbody></table></div>
      </section>
      <section class="section">
        <div class="section-header"><h2>Top productos con mayor variacion</h2></div>
        <div class="section-body"><div class="chart-list">${productChart}</div><table><thead><tr><th>Producto</th><th>Categoria</th><th>Monto</th><th>%</th></tr></thead><tbody>${productRows}</tbody></table></div>
      </section>
      <section class="section">
        <div class="section-header"><h2>Sugerencia de compra Intelipar</h2></div>
        <div class="section-body"><table><thead><tr><th>Item</th><th>Proveedor</th><th>Stock</th><th>Sugerido</th><th>Nota</th></tr></thead><tbody>${purchaseRows}</tbody></table></div>
      </section>
    </main>
    <footer>Reporte generado por Bevinco CMS. Revisar comentarios y proveedores antes del envio final.</footer>
  </article>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compactMoney(value) {
  const absValue = Math.abs(value || 0);
  const sign = (value || 0) < 0 ? "-" : "";
  if (absValue >= 1000000) return `${sign}$${(absValue / 1000000).toFixed(1)}M`;
  if (absValue >= 1000) return `${sign}$${(absValue / 1000).toFixed(0)}K`;
  return `${sign}$${Math.round(absValue)}`;
}

function shortPeriodLabel(label) {
  const text = String(label || "").replace(/\s*2026/i, "").trim();
  const match = text.match(/^([A-Za-z]+)\s+(\d+)\s+to\s+([A-Za-z]+)?\s*(\d+)$/i);
  if (!match) return text.replace(/\s+to\s+/i, " - ");

  const [, startMonth, startDay, endMonth, endDay] = match;
  const finalEndMonth = endMonth || startMonth;
  return `${startDay} ${startMonth.slice(0, 3)} - ${endDay} ${finalEndMonth.slice(0, 3)}`;
}

function truncateLabel(value, maxLength = 24) {
  const label = String(value || "");
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

function renderCostSvg(history, money) {
  const width = 1080;
  const height = 340;
  const left = 72;
  const right = 48;
  const top = 36;
  const bottom = 78;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const maxRevenue = Math.max(...history.map((item) => item.revenue || 0), 1);
  const maxPercent = Math.max(60, ...history.map((item) => (item.costPercent || 0) + 8));
  const step = history.length > 1 ? chartWidth / (history.length - 1) : chartWidth;
  const realPoints = [];
  const bars = history
    .map((item, index) => {
      const x = left + index * step;
      const barHeight = ((item.revenue || 0) / maxRevenue) * (chartHeight * 0.72);
      const barWidth = Math.min(78, chartWidth / Math.max(history.length, 1) * 0.36);
      const barY = top + chartHeight - barHeight;
      const real = item.costPercent || 0;
      const realY = top + chartHeight - (real / maxPercent) * chartHeight;
      const realBadgeY = Math.max(top + 4, realY - 30);
      realPoints.push(`${x},${realY}`);

      return `
        <rect x="${x - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="#88c8bf" />
        <text x="${x}" y="${top + chartHeight + 34}" text-anchor="middle" class="axis-label">${escapeHtml(shortPeriodLabel(item.label))}</text>
        <text x="${x}" y="${Math.max(barY + 18, top + 18)}" text-anchor="middle" class="bar-value">${compactMoney(item.revenue)}</text>
        <rect x="${x - 24}" y="${realBadgeY}" width="48" height="20" rx="4" fill="#05264d" />
        <text x="${x}" y="${realBadgeY + 14}" text-anchor="middle" class="point-label">${real.toFixed(1)}%</text>`;
    })
    .join("");
  const grid = [0, 15, 30, 45, 60].map((tick) => {
    const y = top + chartHeight - (tick / maxPercent) * chartHeight;
    return `<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#e4e8e6" /><text x="${left - 12}" y="${y + 4}" text-anchor="end" class="axis-label">${tick}%</text>`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ingresos y porcentaje de costo real">
    <style>.axis-label{font:12px Poppins,Arial;fill:#8b918f}.bar-value{font:700 12px Poppins,Arial;fill:#fff}.point-label{font:700 10px Poppins,Arial;fill:#fff}</style>
    ${grid}
    ${bars}
    <polyline points="${realPoints.join(" ")}" fill="none" stroke="#05264d" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    <g transform="translate(${left + 320},${height - 16})">
      <rect width="14" height="4" fill="#88c8bf" /><text x="20" y="4" class="axis-label">Suma de ingresos</text>
      <line x1="170" x2="196" y1="2" y2="2" stroke="#05264d" stroke-width="4" /><text x="204" y="4" class="axis-label">% costo real</text>
    </g>
  </svg>`;
}

function renderVarianceSvg(items, money) {
  const rows = items.slice(0, 10);
  const width = 980;
  const rowHeight = 34;
  const height = 76 + rows.length * rowHeight;
  const center = 520;
  const maxValue = Math.max(...rows.map((item) => Math.abs(item.amount || item.varianceAmount || 0)), 1);
  const maxBarWidth = 360;
  const rowMarkup = rows.map((item, index) => {
    const amount = item.amount ?? item.varianceAmount ?? 0;
    const label = item.name || item.category || "Sin nombre";
    const y = 52 + index * rowHeight;
    const barWidth = Math.max(10, (Math.abs(amount) / maxValue) * maxBarWidth);
    const isNegative = amount < 0;
    const x = isNegative ? center - barWidth : center;
    const color = isNegative ? "#6b4539" : "#4b9086";
    const textX = isNegative ? x - 6 : x + barWidth + 6;
    const textAnchor = isNegative ? "end" : "start";
    return `
      <text x="18" y="${y + 5}" class="category-label">${escapeHtml(truncateLabel(label, 34))}</text>
      <rect x="${x}" y="${y - 12}" width="${barWidth}" height="18" rx="3" fill="${color}" />
      <text x="${textX}" y="${y + 2}" text-anchor="${textAnchor}" class="amount-label">${compactMoney(amount)}</text>`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ahorro y faltantes de inventario">
    <style>.category-label{font:13px Poppins,Arial;fill:#565d5a}.amount-label{font:700 12px Poppins,Arial;fill:#172026}</style>
    <line x1="${center}" x2="${center}" y1="34" y2="${height - 20}" stroke="#dfe5e3" />
    <text x="${center - 92}" y="22" text-anchor="middle" class="category-label">Faltantes</text>
    <text x="${center + 92}" y="22" text-anchor="middle" class="category-label">Ahorros</text>
    ${rowMarkup}
  </svg>`;
}

function renderPurchaseSvg(items) {
  const rows = items.slice(0, 8).map((item) => ({
    label: item.item,
    stock: parseNumber(item.stock),
    suggested: parseNumber(item.suggested),
  }));
  const width = 980;
  const rowHeight = 38;
  const height = 76 + rows.length * rowHeight;
  const left = 300;
  const maxBarWidth = 460;
  const maxValue = Math.max(...rows.map((item) => Math.max(item.stock, item.suggested)), 1);
  const rowMarkup = rows.map((item, index) => {
    const y = 50 + index * rowHeight;
    const stockWidth = Math.max(5, (item.stock / maxValue) * maxBarWidth);
    const suggestedWidth = Math.max(5, (item.suggested / maxValue) * maxBarWidth);
    return `
      <text x="16" y="${y + 6}" class="purchase-label">${escapeHtml(truncateLabel(item.label, 32))}</text>
      <rect x="${left}" y="${y - 12}" width="${stockWidth}" height="10" rx="3" fill="#05264d" opacity="0.78" />
      <rect x="${left}" y="${y + 3}" width="${suggestedWidth}" height="10" rx="3" fill="#8cc24a" opacity="0.9" />`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Stock versus compra sugerida">
    <style>.purchase-label{font:13px Poppins,Arial;fill:#565d5a}.purchase-value{font:700 12px Poppins,Arial;fill:#565d5a}</style>
    <text x="${left}" y="24" class="purchase-value">Stock actual</text>
    <text x="${left + 150}" y="24" class="purchase-value" fill="#8cc24a">Compra sugerida</text>
    ${rowMarkup}
  </svg>`;
}

function renderAnalysisList(title, items) {
  const fallbackItems = items.length ? items : ["Sin hallazgos relevantes para este bloque en el periodo seleccionado."];

  return `<div class="analysis-block"><h3>${escapeHtml(title)}</h3><ul>${fallbackItems
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul></div>`;
}

function renderPolishedReportHtml(store, report) {
  const payload = buildReportPayload(store, report);
  const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const generatedAt = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const positiveTotal = payload.categoryVariances.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0);
  const negativeTotal = payload.categoryVariances.filter((item) => item.amount < 0).reduce((sum, item) => sum + item.amount, 0);
  const topCategory = [...payload.categoryVariances].sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))[0];
  const costSvg = renderCostSvg(payload.history, money);
  const varianceSvg = renderVarianceSvg(payload.categoryVariances, money);
  const productSvg = renderVarianceSvg(payload.topProducts, money);
  const purchaseSvg = renderPurchaseSvg(payload.purchaseSuggestions);
  const analysis = payload.analysis || generateReportAnalysis(payload);
  const categoryRows = payload.categoryVariances.map((item) => `<tr><td class="text-cell">${escapeHtml(item.category)}</td><td class="money-cell ${item.amount < 0 ? "bad" : "ok"}">${money.format(item.amount)}</td><td class="percent-cell">${item.percent}%</td></tr>`).join("");
  const productRows = payload.topProducts.map((item) => `<tr><td class="text-cell strong-cell">${escapeHtml(item.name)}</td><td class="text-cell">${escapeHtml(item.category)}</td><td class="money-cell ${item.varianceAmount < 0 ? "bad" : "ok"}">${money.format(item.varianceAmount)}</td><td class="percent-cell">${item.variancePercent}%</td></tr>`).join("");
  const purchaseRows = payload.purchaseSuggestions.map((item) => `<tr><td class="text-cell strong-cell">${escapeHtml(item.item)}</td><td class="text-cell">${escapeHtml(item.provider)}</td><td class="small-number-cell">${escapeHtml(item.stock)}</td><td class="small-number-cell">${escapeHtml(item.suggested)}</td><td class="note-cell">${escapeHtml(item.note)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reporte ${escapeHtml(payload.client?.name || report.clientId)}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap");
    @page { margin: 9mm; size: A4 landscape; }
    * { box-sizing: border-box; }
    body { background: #e9efed; color: #16211f; font-family: "Poppins", Arial, Helvetica, sans-serif; line-height: 1.35; margin: 0; padding: 18px; }
    .toolbar { display: flex; justify-content: flex-end; margin: 0 auto 14px; max-width: 1120px; }
    button { background: #0b2d55; border: 0; border-radius: 6px; color: #fff; cursor: pointer; font-weight: 700; min-height: 40px; padding: 0 16px; }
    .sheet { background: #fff; border: 1px solid #d9e1df; margin: 0 auto; max-width: 1120px; min-height: 100vh; padding: 24px 30px; }
    .cover { display: grid; grid-template-columns: 108px 1fr 160px; align-items: start; gap: 22px; margin-bottom: 18px; }
    .mark-grid { display: grid; grid-template-columns: repeat(2, 42px); gap: 6px; }
    .mark-grid span { border: 3px solid #8cc24a; border-radius: 11px; height: 42px; }
    .mark-grid span:nth-child(2) { background: #8cc24a; }
    .mark-grid span:nth-child(3) { background: #8ac8c2; border-color: #8ac8c2; }
    .mark-grid span:nth-child(4) { background: #d8d8d8; border-color: #d8d8d8; }
    h1 { color: #535353; font-size: 40px; letter-spacing: 0; line-height: 1; margin: 0; text-align: center; }
    .green-rule { background: #7bb344; height: 4px; margin: 10px auto 0; max-width: 470px; }
    .period-box { border: 3px solid #7bb344; color: #535353; display: grid; font-size: 12px; grid-template-columns: 1fr 1fr; margin-left: auto; padding: 6px; row-gap: 3px; text-align: right; }
    .period-box strong { text-align: center; grid-column: span 2; }
    .meta-line { color: #7d8582; font-size: 12px; text-align: center; margin-top: 8px; }
    .metrics { display: grid; gap: 12px; grid-template-columns: repeat(4, 1fr); margin: 16px 0 18px; }
    .metric { border: 1px solid #dde5e2; border-radius: 6px; padding: 12px; text-align: center; }
    .metric span { color: #61706c; display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .metric strong { display: block; font-size: 22px; margin-top: 5px; }
    .section { border: 1px solid #dce4e2; border-radius: 6px; margin-bottom: 16px; overflow: hidden; page-break-inside: avoid; }
    .section h2 { background: #f6f8f7; border-bottom: 1px solid #dce4e2; color: #1c2724; font-size: 19px; margin: 0; padding: 12px 16px; }
    .section-body { padding: 14px 16px 16px; }
    .chart-card { border: 1px solid #e2e7e5; margin-bottom: 14px; padding: 10px; overflow: hidden; }
    .chart-card h3 { color: #909090; font-size: 18px; margin: 0 0 8px; text-align: center; }
    .chart-note { color: #5b6763; font-size: 12px; margin: 0 0 8px; }
    .report-svg { display: block; height: auto; width: 100%; }
    .two-col { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.7fr) minmax(210px, 0.8fr); }
    .summary-box { border: 1px solid #d8dfdc; color: #555; font-size: 13px; padding: 12px; white-space: pre-wrap; }
    .analysis-grid { border: 1px solid #d8dfdc; display: grid; gap: 12px; padding: 14px; }
    .analysis-block h3 { color: #4eb0cf; font-size: 15px; margin: 0 0 7px; }
    .analysis-block ul { display: grid; gap: 7px; margin: 0; padding: 0 0 0 18px; }
    .analysis-block li { color: #555; font-size: 12px; padding-left: 4px; }
    .agent-list { display: grid; gap: 8px; margin: 0; padding-left: 18px; }
    .agent-list li { color: #555; font-size: 12px; }
    .stat-stack { display: grid; gap: 16px; align-content: start; }
    .stat-box { border: 3px solid #0b2d55; text-align: center; }
    .stat-box h3 { background: #0b2d55; color: #fff; font-size: 13px; margin: 0; padding: 5px; }
    .stat-box strong { color: #555; display: block; font-size: 22px; padding: 8px; }
    table { border-collapse: collapse; table-layout: fixed; width: 100%; }
    th, td { border-bottom: 1px solid #e5ebe8; font-size: 11px; overflow-wrap: anywhere; padding: 8px 10px; vertical-align: middle; }
    th { background: #fbfcfc; color: #465c56; font-size: 10px; font-weight: 800; text-transform: uppercase; }
    tbody tr:nth-child(even) td { background: #fbfcfc; }
    .text-cell { text-align: left; }
    .strong-cell { font-weight: 800; }
    .money-cell,
    .percent-cell,
    .small-number-cell { text-align: center; white-space: nowrap; }
    .note-cell { text-align: left; }
    .w-category-name { width: 54%; }
    .w-category-money { width: 26%; }
    .w-category-percent { width: 20%; }
    .w-product-name { width: 32%; }
    .w-product-category { width: 25%; }
    .w-product-money { width: 25%; }
    .w-product-percent { width: 18%; }
    .w-purchase-item { width: 28%; }
    .w-purchase-provider { width: 20%; }
    .w-purchase-stock { width: 11%; }
    .w-purchase-suggested { width: 11%; }
    .w-purchase-note { width: 30%; }
    .ok { color: #006b4f; }
    .bad { color: #a22a22; }
    footer { border-top: 1px solid #dce4e2; color: #777; font-size: 11px; margin-top: 24px; padding-top: 12px; text-align: center; }
    .page-break { break-before: page; page-break-before: always; }
    @media print { body { background: #fff; padding: 0; } .toolbar { display: none; } .sheet { border: 0; max-width: none; padding: 0; } .section { break-inside: avoid; } }
  </style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Guardar como PDF</button></div>
  <main class="sheet">
    <header class="cover">
      <div class="mark-grid"><span></span><span></span><span></span><span></span></div>
      <div><h1>${escapeHtml(payload.client?.name || report.clientId)}</h1><div class="green-rule"></div><p class="meta-line">Reporte semanal generado ${escapeHtml(generatedAt)} · ${escapeHtml(payload.client?.area || "")}</p></div>
      <div class="period-box"><strong>Periodo</strong><span>del:</span><b>${escapeHtml(payload.period?.startsAt || "")}</b><span>al:</span><b>${escapeHtml(payload.period?.endsAt || "")}</b></div>
    </header>
    <section class="metrics">
      <div class="metric"><span>Ingresos</span><strong>${money.format(payload.summary.revenue)}</strong></div>
      <div class="metric"><span>% costo</span><strong>${payload.summary.costPercent}%</strong></div>
      <div class="metric"><span>Variance</span><strong>${payload.summary.variancePercent}%</strong></div>
      <div class="metric"><span>Diferencia</span><strong class="${payload.summary.varianceAmount < 0 ? "bad" : "ok"}">${money.format(payload.summary.varianceAmount)}</strong></div>
    </section>
    <section class="section"><h2>Ingresos y % costo real</h2><div class="section-body"><div class="chart-card">${costSvg}</div></div></section>
    <section class="two-col">
      <div class="section"><h2>Ahorro/faltantes inventario ($)</h2><div class="section-body"><div class="chart-card">${varianceSvg}</div></div></section>
      <aside class="stat-stack">
        <div class="stat-box"><h3>Suma de ahorros</h3><strong>${money.format(positiveTotal)}</strong></div>
        <div class="stat-box"><h3>Suma de faltantes</h3><strong>${money.format(negativeTotal)}</strong></div>
        <div class="stat-box"><h3>Mayor impacto</h3><strong>${escapeHtml(topCategory?.category || "S/I")}</strong></div>
      </aside>
    </section>
    <section class="section"><h2>Lectura ejecutiva del periodo</h2><div class="section-body"><div class="analysis-grid">
      ${renderAnalysisList("Lo mejor de la semana", analysis.bestOfWeek || [])}
      ${renderAnalysisList("Los desafios de la semana", analysis.weeklyChallenges || [])}
      ${renderAnalysisList("Eficiencia de stock y compra", analysis.stockEfficiency || [])}
    </div></div></section>
    <section class="section"><h2>Resumen generado por el agente de reportes</h2><div class="section-body"><div class="summary-box"><ul class="agent-list">${(analysis.agentNotes || [])
      .map((paragraph) => `<li>${escapeHtml(paragraph)}</li>`)
      .join("")}</ul></div></div></section>
    <section class="section page-break"><h2>Variaciones por categoria</h2><div class="section-body"><table><colgroup><col class="w-category-name"><col class="w-category-money"><col class="w-category-percent"></colgroup><thead><tr><th class="text-cell">Categoria</th><th class="money-cell">Monto</th><th class="percent-cell">%</th></tr></thead><tbody>${categoryRows}</tbody></table></div></section>
    <section class="section"><h2>Top productos con mayor variacion</h2><div class="section-body"><div class="chart-card">${productSvg}</div><table><colgroup><col class="w-product-name"><col class="w-product-category"><col class="w-product-money"><col class="w-product-percent"></colgroup><thead><tr><th class="text-cell">Producto</th><th class="text-cell">Categoria</th><th class="money-cell">Monto</th><th class="percent-cell">%</th></tr></thead><tbody>${productRows}</tbody></table></div></section>
    <section class="section"><h2>Sugerencia de compra Intelipar</h2><div class="section-body"><p class="chart-note">Azul: stock actual. Verde: compra sugerida por Intelipar.</p><div class="chart-card">${purchaseSvg}</div><table><colgroup><col class="w-purchase-item"><col class="w-purchase-provider"><col class="w-purchase-stock"><col class="w-purchase-suggested"><col class="w-purchase-note"></colgroup><thead><tr><th class="text-cell">Item</th><th class="text-cell">Proveedor</th><th class="small-number-cell">Stock</th><th class="small-number-cell">Sugerido</th><th class="note-cell">Nota</th></tr></thead><tbody>${purchaseRows}</tbody></table></div></section>
    <footer>Reporte generado por Bevinco CMS. Revisar comentarios y proveedores antes del envio final.</footer>
  </main>
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

app.post("/api/module1/clients", requireAuth, async (request, response) => {
  const store = await readStore();
  const client = ensureClient(store, request.body || {});
  await writeStore(store);
  response.json({ client, clients: store.clients });
});

app.post("/api/module1/periods", requireAuth, async (request, response) => {
  const store = await readStore();
  const period = ensurePeriod(store, request.body || {});
  await writeStore(store);
  response.json({ period, periods: store.periods });
});

app.post("/api/module1/import-csv", requireAuth, async (request, response) => {
  const store = await readStore();
  const { clientId, periodId, sourceType = "auto", csvText, files, client, period } = request.body || {};

  const resolvedClient = client ? ensureClient(store, client) : store.clients.find((candidate) => candidate.id === clientId);
  const resolvedPeriod = period ? ensurePeriod(store, period) : store.periods.find((candidate) => candidate.id === periodId);

  if (!resolvedClient || !resolvedPeriod) {
    response.status(400).json({ error: "Client and period are required." });
    return;
  }

  if (!["auto", "varianceDetailed", "varianceSummary", "intelipar"].includes(sourceType)) {
    response.status(400).json({ error: "Invalid sourceType." });
    return;
  }

  const incomingFiles = Array.isArray(files)
    ? files
    : csvText
      ? [{ name: "uploaded.csv", csvText }]
      : [];

  if (!incomingFiles.length) {
    response.status(400).json({ error: "At least one CSV file is required." });
    return;
  }

  const report = reportForClientPeriod(store, resolvedClient.id, resolvedPeriod.id);
  const imported = [];

  incomingFiles.forEach((file) => {
    const rows = parseCsv(file.csvText || "");
    const detectedSourceType = sourceType === "auto" ? detectCsvSourceType(rows, file.name) : sourceType;
    applyCsvToReport(report, detectedSourceType, rows);
    imported.push({
      fileName: file.name || "uploaded.csv",
      sourceType: detectedSourceType,
      rows: rows.length,
    });
  });

  if (!report.comments) report.comments = commentsForReport(resolvedClient.name, report);

  await writeStore(store);
  response.json({
    clients: store.clients,
    periods: store.periods,
    reports: store.reports.map((item) => buildReportPayload(store, item)),
    selectedReport: buildReportPayload(store, report),
    imported,
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
      report.sourceStatus[type] = "Por revisar";
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

  const allowedFields = ["status", "comments", "emailDraft", "analysis", "summary", "categoryVariances", "topProducts", "purchaseSuggestions"];
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(request.body, field)) {
      report[field] = request.body[field];
    }
  });

  report.updatedAt = new Date().toISOString();
  await writeStore(store);
  response.json(buildReportPayload(store, report));
});

app.post("/api/module1/reports/:reportId/summary", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).json({ error: "Report not found." });
    return;
  }

  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const generatedSummary = generateReportSummary(store, report);
  report.comments = generatedSummary;
  report.analysis = generateReportAnalysis(buildReportPayload(store, report));
  report.emailDraft = [
    `Hola,`,
    "",
    `Compartimos el reporte semanal de auditoria de ${client?.name || report.clientId}.`,
    "",
    generatedSummary,
    "",
    "Quedamos atentos a cualquier duda o comentario.",
  ].join("\n");
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
  response.send(renderPolishedReportHtml(store, report));
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
      html: renderPolishedReportHtml(store, report),
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
