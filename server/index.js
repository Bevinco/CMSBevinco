import path from "node:path";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadLocalEnvFile() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fsSync.existsSync(envPath)) return;

  const rawEnv = fsSync.readFileSync(envPath, "utf8");
  rawEnv.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!match) return;
    const key = match[1].trim();
    if (process.env[key] !== undefined) return;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

loadLocalEnvFile();

const app = express();
const port = process.env.PORT || 3000;

const sculptureBaseUrl =
  process.env.SCULPTURE_BASE_URL || "https://beta.food.sculpturehospitality.com";
const sculptureFoodBaseUrl =
  process.env.SCULPTURE_FOOD_BASE_URL || sculptureBaseUrl;
const sculptureBeverageBaseUrl =
  process.env.SCULPTURE_BEVERAGE_BASE_URL || "https://beta.beverage.sculpturehospitality.com";
const defaultCid = process.env.SCULPTURE_DEFAULT_CID || "29088";
const defaultPid = process.env.SCULPTURE_DEFAULT_PID || "36";
const sculptureUsername =
  process.env.SCULPTURE_USERNAME || process.env.SCULPTURE_USER || process.env.SCULPTURE_AUTH_USERNAME || "";
const sculpturePassword =
  process.env.SCULPTURE_PASSWORD || process.env.SCULPTURE_PASS || process.env.SCULPTURE_AUTH_PASSWORD || "";
const sculptureLoginPath = process.env.SCULPTURE_LOGIN_PATH || "/login/";
const sculptureLoginUsernameField = process.env.SCULPTURE_LOGIN_USERNAME_FIELD || "";
const sculptureLoginPasswordField = process.env.SCULPTURE_LOGIN_PASSWORD_FIELD || "";
const clickupBaseUrl = process.env.CLICKUP_BASE_URL || "https://api.clickup.com/api/v2";
const clickupListId = process.env.CLICKUP_LIST_ID || process.env.VITE_CLICKUP_LIST_ID || "";
const clickupClientId = process.env.CLICKUP_CLIENT_ID || "";
const clickupClientSecret = process.env.CLICKUP_CLIENT_SECRET || "";
const clickupDefaultStatuses = (process.env.CLICKUP_VISIBLE_STATUSES ||
  "FALTA INFORMACION,AUDITORIA EN PROCESO,GRAFICOS ACTUALIZADOS,LISTO PARA REPORTE,COMENTARIOS ESCRITOS,REPORTE ENVIADO,CANCELADO")
  .split(",")
  .map((status) => status.trim())
  .filter(Boolean);
const clickupDefaultTaskStatus = process.env.CLICKUP_DEFAULT_TASK_STATUS || "LISTO PARA REPORTE";
const authUsername = process.env.CMS_AUTH_USERNAME;
const authPassword = process.env.CMS_AUTH_PASSWORD;
const sessionSecret = process.env.CMS_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const sessionCookieName = "bevinco_session";
const dataDir = path.resolve(__dirname, "../data");
const moduleStorePath = path.join(dataDir, "module1.json");
const publicDir = path.resolve(__dirname, "public");
const sculptureSessionCookieCache = new Map();
let clickupAccessTokenCache = "";

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
      name: "Bardot - Barra",
      accountName: "Bardot",
      moduleName: "Barra",
      cid: "bardot-barra",
      sculptureCid: defaultCid,
      area: "Beverage",
      recipients: ["operaciones@bardot.cl"],
    },
    varianceFile: "Bardot barra-Detailed Variance Report for Jun 4 to Jun 10 2026.csv",
    inteliparFile: "Bardot barra - inteliPar Report for Jun 4 to Jun 10 2026.csv",
  },
  {
    client: {
      id: "bardot-cocina",
      name: "Bardot - Cocina",
      accountName: "Bardot",
      moduleName: "Cocina",
      cid: "bardot-cocina",
      sculptureCid: defaultCid,
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

function parseSculptureTableElement($, table) {
  let headers = $(table)
    .find("thead th")
    .map((_, element) => $(element).text().trim().replace(/\s+/g, " "))
    .get();

  if (!headers.length) {
    headers = $(table)
      .find("tr")
      .first()
      .find("th")
      .map((_, element) => $(element).text().trim().replace(/\s+/g, " "))
      .get();
  }

  const bodyRows = $(table).find("tbody tr").length ? $(table).find("tbody tr") : $(table).find("tr");
  const rows = [];
  let currentGroup = "";

  bodyRows.each((rowIndex, row) => {
    if (!$(row).find("td").length) return;

    const cells = $(row)
      .find("td")
      .map((__, cell) => $(cell).text().trim().replace(/\s+/g, " "))
      .get();

    if (!cells.length) return;

    if (!headers.length && rowIndex === 0) {
      headers = cells;
      return;
    }

    const filledCells = cells.filter(Boolean);
    if (filledCells.length === 1 && (!headers.length || cells.length < headers.length)) {
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

function parseSculptureTable(html) {
  const $ = cheerio.load(html);
  const tables = $("table")
    .map((_, table) => parseSculptureTableElement($, table))
    .get();

  return tables.sort((left, right) => {
    if (right.rows.length !== left.rows.length) return right.rows.length - left.rows.length;
    return right.headers.length - left.headers.length;
  })[0] || { headers: [], rows: [] };
}

function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const singleHeader = response.headers.get("set-cookie");
  return singleHeader ? [singleHeader] : [];
}

function mergeCookieHeaders(...cookieInputs) {
  const cookies = new Map();

  cookieInputs
    .flat()
    .filter(Boolean)
    .forEach((cookieInput) => {
      String(cookieInput)
        .split(/,(?=\s*[^;,]+=)/)
        .map((cookiePart) => cookiePart.trim().split(";")[0])
        .filter((cookiePart) => cookiePart.includes("="))
        .forEach((cookiePart) => {
          const [name, ...valueParts] = cookiePart.split("=");
          cookies.set(name.trim(), valueParts.join("=").trim());
        });
    });

  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function looksLikeSculptureLogin(html) {
  const body = String(html || "").toLowerCase();
  return body.includes("password") && (body.includes("login") || body.includes("sign in") || body.includes("usuario"));
}

function baseUrlForSculptureArea(area = "") {
  return String(area || "").toLowerCase().includes("beverage") || String(area || "").toLowerCase().includes("barra")
    ? sculptureBeverageBaseUrl
    : sculptureFoodBaseUrl;
}

async function fetchSculptureLoginCookie(baseUrl = sculptureFoodBaseUrl) {
  if (!sculptureUsername || !sculpturePassword) return "";

  const loginUrl = new URL(sculptureLoginPath, baseUrl).toString();
  const loginPageResponse = await fetch(loginUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      referer: `${baseUrl}/`,
    },
    redirect: "manual",
  });
  const loginPageHtml = await loginPageResponse.text();
  const loginPageCookie = mergeCookieHeaders(getSetCookieHeaders(loginPageResponse));
  const $ = cheerio.load(loginPageHtml);
  const form = $("form").first();
  const formAction = form.attr("action");
  const postUrl = formAction ? new URL(formAction, loginUrl).toString() : loginUrl;
  const usernameField =
    sculptureLoginUsernameField ||
    form.find('input[type="email"]').attr("name") ||
    form.find('input[name*="email" i]').attr("name") ||
    form.find('input[name*="user" i]').attr("name") ||
    "email";
  const passwordField =
    sculptureLoginPasswordField ||
    form.find('input[type="password"]').attr("name") ||
    form.find('input[name*="password" i]').attr("name") ||
    "password";
  const body = new URLSearchParams();

  form.find("input[name]").each((_, input) => {
    const name = $(input).attr("name");
    if (!name) return;
    body.set(name, $(input).attr("value") || "");
  });
  body.set(usernameField, sculptureUsername);
  body.set(passwordField, sculpturePassword);

  const loginResponse = await fetch(postUrl, {
    method: "POST",
    headers: {
      accept: "text/html, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      cookie: loginPageCookie,
      origin: baseUrl,
      referer: loginUrl,
    },
    body,
    redirect: "manual",
  });

  let cookie = mergeCookieHeaders(loginPageCookie, getSetCookieHeaders(loginResponse));
  const redirectLocation = loginResponse.headers.get("location");

  if (redirectLocation && loginResponse.status >= 300 && loginResponse.status < 400) {
    const redirectResponse = await fetch(new URL(redirectLocation, postUrl).toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        cookie,
        referer: postUrl,
      },
      redirect: "manual",
    });
    await redirectResponse.arrayBuffer();
    cookie = mergeCookieHeaders(cookie, getSetCookieHeaders(redirectResponse));
  } else {
    await loginResponse.arrayBuffer();
  }

  sculptureSessionCookieCache.set(baseUrl, cookie);
  return cookie;
}

async function getSculptureCookie({ forceLogin = false, baseUrl = sculptureFoodBaseUrl } = {}) {
  if (!forceLogin && process.env.SCULPTURE_SESSION_COOKIE) return process.env.SCULPTURE_SESSION_COOKIE;
  if (!forceLogin && sculptureSessionCookieCache.get(baseUrl)) return sculptureSessionCookieCache.get(baseUrl);

  const cookie = await fetchSculptureLoginCookie(baseUrl);
  if (cookie) return cookie;

  const error = new Error("SCULPTURE_SESSION_COOKIE or SCULPTURE_USERNAME/SCULPTURE_PASSWORD must be configured.");
  error.status = 503;
  throw error;
}

function configuredIdentifier(...values) {
  return values.find((value) => /^\d+$/.test(String(value || "").trim())) || "";
}

function cleanSculptureUnitName(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^(select|seleccionar|choose)\s+/i, "")
    .trim();
}

function extractCidFromValue(value = "") {
  const text = String(value || "");
  return (
    text.match(/[?&]cid=(\d+)/i)?.[1] ||
    text.match(/(?:^|[^\d])cid[/:=-](\d+)/i)?.[1] ||
    text.match(/(?:client|company|location|restaurant)[_-]?id[/:=-](\d+)/i)?.[1] ||
    ""
  );
}

function parseSculptureUnitsFromHtml(html, { area, baseUrl }) {
  const $ = cheerio.load(html);
  const units = new Map();
  const addUnit = ({ cid, name, href = "", externalCode = "" }) => {
    const cleanName = cleanSculptureUnitName(name);
    const resolvedCid = configuredIdentifier(cid, extractCidFromValue(href));
    if (!resolvedCid || !cleanName || cleanName.length < 3) return;
    if (/sign out|support|account|detailed reporting|home|inventory|reports/i.test(cleanName)) return;

    const accountName = cleanName
      .replace(/^\d+\s+/, "")
      .replace(/\s*[-·]\s*(barra|bar|cocina|food|beverage)$/i, "")
      .trim();
    const moduleName = /barra|bar|beverage/i.test(`${cleanName} ${area}`)
      ? "Barra"
      : /cocina|food/i.test(`${cleanName} ${area}`)
        ? "Cocina"
        : area;
    const id = `${resolvedCid}-${moduleName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    units.set(`${resolvedCid}-${area}`, {
      id,
      name: `${accountName || cleanName} - ${moduleName}`,
      accountName: accountName || cleanName,
      moduleName,
      cid: resolvedCid,
      sculptureCid: resolvedCid,
      externalCode,
      area,
      baseUrl,
      source: "sculpture",
    });
  };

  $("option").each((_, option) => {
    const element = $(option);
    const value = element.attr("value") || "";
    addUnit({
      cid: element.attr("data-cid") || element.attr("data-client-id") || element.attr("data-company-id") || configuredIdentifier(value, extractCidFromValue(value)),
      name: element.text(),
      href: value,
    });
  });

  $("a, button, [data-cid], [data-client-id], [data-company-id]").each((_, node) => {
    const element = $(node);
    const href = element.attr("href") || element.attr("data-url") || element.attr("value") || "";
    const label = element.text() || element.attr("title") || element.attr("aria-label") || "";
    addUnit({
      cid: element.attr("data-cid") || element.attr("data-client-id") || element.attr("data-company-id") || configuredIdentifier(element.attr("value"), extractCidFromValue(href)),
      name: label,
      href,
    });
  });

  return Array.from(units.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeMonthName(month = "") {
  const normalized = String(month || "").slice(0, 3).toLowerCase();
  const monthMap = {
    jan: "01",
    ene: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    abr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    ago: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
    dic: "12",
  };
  return monthMap[normalized] || "";
}

function parseSculpturePeriodDates(label = "") {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  const match = text.match(/([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+(\d{1,2})\s+(?:to|al|-)\s+(?:(\w+)\s+)?(\d{1,2})\s+(\d{4})/i);
  if (!match) return { startsAt: "", endsAt: "" };

  const [, startMonthName, startDay, endMonthName, endDay, year] = match;
  const startMonth = normalizeMonthName(startMonthName);
  const endMonth = normalizeMonthName(endMonthName || startMonthName);
  if (!startMonth || !endMonth) return { startsAt: "", endsAt: "" };

  return {
    startsAt: `${year}-${startMonth}-${String(startDay).padStart(2, "0")}`,
    endsAt: `${year}-${endMonth}-${String(endDay).padStart(2, "0")}`,
  };
}

function looksLikeSculpturePeriodLabel(value = "") {
  const text = String(value || "").toLowerCase();
  return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic)\b/.test(text) &&
    (text.includes(" to ") || text.includes(" al ") || /\d{4}/.test(text));
}

function extractSculpturePeriodId(value = "") {
  return configuredIdentifier(
    String(value || "").match(/[?&](?:pid|periodid|period_id)=(\d+)/i)?.[1],
    String(value || "").match(/\b(?:pid|periodid|period_id)\D{0,8}(\d+)/i)?.[1],
    value,
  );
}

function parseSculpturePeriodsFromHtml(html) {
  const $ = cheerio.load(html);
  const periods = new Map();
  const addPeriod = ({ pid, label }) => {
    const cleanLabel = cleanSculptureUnitName(label);
    const resolvedPid = configuredIdentifier(pid);
    if (!resolvedPid || !looksLikeSculpturePeriodLabel(cleanLabel)) return;
    const { startsAt, endsAt } = parseSculpturePeriodDates(cleanLabel);
    periods.set(resolvedPid, {
      id: `sculpture-${resolvedPid}`,
      label: cleanLabel,
      startsAt,
      endsAt,
      pid: resolvedPid,
      sculpturePid: resolvedPid,
      source: "sculpture",
    });
  };

  $("option").each((_, option) => {
    const element = $(option);
    const value = element.attr("value") || "";
    addPeriod({ pid: configuredIdentifier(value, extractCidFromValue(value)), label: element.text() });
  });

  $("a, button, [data-pid], [data-period-id]").each((_, node) => {
    const element = $(node);
    const href = element.attr("href") || element.attr("data-url") || element.attr("value") || "";
    const label = element.text() || element.attr("title") || element.attr("aria-label") || "";
    addPeriod({
      pid: element.attr("data-pid") || element.attr("data-period-id") || extractSculpturePeriodId(element.attr("value")) || extractSculpturePeriodId(href),
      label,
    });
  });

  const periodLinkPattern = /href=["'][^"']*(?:pid|periodid|period_id)=(\d+)[^"']*["'][^>]*>([^<]+)</gi;
  for (const match of html.matchAll(periodLinkPattern)) {
    addPeriod({ pid: match[1], label: match[2] });
  }

  return Array.from(periods.values()).sort((left, right) => String(right.startsAt || right.label).localeCompare(String(left.startsAt || left.label)));
}

async function fetchSculpturePage({ baseUrl, path: pagePath = "/" }) {
  const requestPage = async (cookie) => {
    const response = await fetch(new URL(pagePath, baseUrl).toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        cookie,
        referer: `${baseUrl}/`,
      },
    });
    const html = await response.text();
    return { response, html };
  };
  let cookie = await getSculptureCookie({ baseUrl });
  let { response, html } = await requestPage(cookie);

  if ((response.status === 401 || response.status === 403 || looksLikeSculptureLogin(html)) && sculptureUsername && sculpturePassword) {
    cookie = await getSculptureCookie({ forceLogin: true, baseUrl });
    ({ response, html } = await requestPage(cookie));
  }

  if (!response.ok || looksLikeSculptureLogin(html)) {
    const error = new Error(`Unable to load Sculpture page ${pagePath}.`);
    error.status = response.status || 401;
    error.details = html.slice(0, 500);
    throw error;
  }

  return html;
}

async function activateSculptureContext({ baseUrl, cid, pid = "", cookie }) {
  let sessionCookie = cookie || (await getSculptureCookie({ baseUrl }));
  let referer = `${baseUrl}/`;

  const visit = async (pagePath) => {
    const response = await fetch(new URL(pagePath, baseUrl).toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        cookie: sessionCookie,
        referer,
      },
      redirect: "manual",
    });
    const html = await response.text();
    sessionCookie = mergeCookieHeaders(sessionCookie, getSetCookieHeaders(response));
    referer = new URL(pagePath, baseUrl).toString();

    if (!response.ok || looksLikeSculptureLogin(html)) {
      const error = new Error(`Unable to activate Sculpture context ${pagePath}.`);
      error.status = response.status || 401;
      error.details = html.slice(0, 500);
      throw error;
    }

    return html;
  };

  let html = await visit(`/?clientid=${encodeURIComponent(cid)}`);
  if (pid) html = await visit(`/?periodid=${encodeURIComponent(pid)}`);

  return { cookie: sessionCookie, html, referer };
}

async function fetchSculpturePeriodsForClient({ baseUrl, cid }) {
  if (!configuredIdentifier(cid)) return [];
  const { html } = await activateSculptureContext({ baseUrl, cid });
  return parseSculpturePeriodsFromHtml(html).map((period) => ({
    ...period,
    id: `sculpture-${cid}-${period.pid}`,
  }));
}

async function discoverSculptureUnits() {
  const targets = [
    { area: "Food", baseUrl: sculptureFoodBaseUrl, paths: ["/", "/reports/variance/", "/requisition/"] },
    { area: "Beverage", baseUrl: sculptureBeverageBaseUrl, paths: ["/", "/reports/variance/", "/requisition/"] },
  ];
  const units = new Map();
  const periods = new Map();
  const errors = [];

  for (const target of targets) {
    for (const pagePath of target.paths) {
      try {
        const html = await fetchSculpturePage({ baseUrl: target.baseUrl, path: pagePath });
        parseSculptureUnitsFromHtml(html, target).forEach((unit) => units.set(`${unit.sculptureCid}-${unit.area}`, unit));
        parseSculpturePeriodsFromHtml(html).forEach((period) => periods.set(period.pid, period));
      } catch (error) {
        errors.push({ area: target.area, path: pagePath, error: error.message });
      }
    }
  }

  return {
    units: Array.from(units.values()).sort((left, right) => left.name.localeCompare(right.name)),
    periods: Array.from(periods.values()),
    errors,
  };
}

function resolveSculptureContext({ client, period, requestBody = {} }) {
  const cid = configuredIdentifier(
    requestBody.cid,
    requestBody.sculptureCid,
    client?.sculptureCid,
    client?.cid,
    defaultCid,
  );
  const pid = configuredIdentifier(
    requestBody.pid,
    requestBody.sculpturePid,
    period?.sculpturePid,
    period?.pid,
    defaultPid,
  );

  return {
    cid,
    pid,
    cidSource: cid === String(client?.cid || "") ? "cliente" : "configuracion",
    pidSource: pid === String(period?.pid || period?.sculpturePid || "") ? "periodo" : "configuracion",
  };
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
  const store = JSON.parse(raw);
  store.clients ||= [];
  store.periods ||= [];
  store.reports ||= [];
  store.criteriaDocuments ||= [];
  return store;
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
      idealCostPercent:
        existing?.summary?.idealCostPercent ||
        report.summary.idealCostPercent ||
        Number(Math.max(0, (report.summary.costPercent || 0) - 1.5).toFixed(1)),
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
  const criteriaApplied = (payload.criteriaDocuments || [])
    .slice(0, 4)
    .map((document) => {
      const excerpt = String(document.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      return `${document.name}: ${excerpt || "criterio disponible para revisar al preparar el reporte."}`;
    });

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
    criteriaApplied,
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
    pid: defaultPid,
    sculpturePid: defaultPid,
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
    criteriaDocuments: [],
  };
}

function pickRecordValue(record, keys, fallback = "") {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== "") return record[key];
  }
  return fallback;
}

function extractReportMetrics(parsedTable) {
  const rows = parsedTable.rows || [];
  const categoryMap = new Map();
  const categoryPercentMap = new Map();
  const products = [];
  let currentCategory = "Sin categoria";
  let revenue = 0;
  let usedCost = 0;
  let soldCost = 0;
  let varianceTotal = 0;
  let grandSummary = null;

  rows.forEach((row) => {
    const values = row.values || [];
    const itemName = pickRecordValue(row.record, ["itemName", "item", "product", "productName", "producto", "nombreArticulo", "nombreArtículo", "nombreArtCulo"], values[0] || "");
    const isGrandTotal = /grand\s+total/i.test(itemName);
    const isCategoryTotal = isTotalRow(itemName) || /^total\s+/i.test(itemName) || /:\s*$/.test(itemName);
    const isTotal = isGrandTotal || isCategoryTotal;
    const category = isTotal
      ? cleanTotalName(itemName)
      : row.group || pickRecordValue(row.record, ["category", "categoria", "categorA"], currentCategory);
    const varianceValue =
      pickRecordValue(row.record, [
        "variance",
        "varianceAmount",
        "difference",
        "extendedDifference",
        "diferenciaCosto",
        "ahorroFaltanteCosto",
        "faltanteCosto",
      ]) ||
      values[values.length - 1] ||
      "0";
    const amount = parseNumber(varianceValue);
    const percentValue =
      pickRecordValue(row.record, ["variancePercent", "differencePercent", "diferencia", "diferenciaPct", "porcentajeDiferencia"]) ||
      values.find((value) => String(value).includes("%"));
    const rowRevenue = parseNumber(pickRecordValue(row.record, ["revenue", "ingresos", "sales", "ventas"]));
    const rowUsedCost = parseNumber(pickRecordValue(row.record, ["usedCost", "usadoCosto", "costoUsado", "usageCost"]));
    const rowSoldCost = parseNumber(pickRecordValue(row.record, ["soldCost", "vendidoCosto", "costoVendido", "salesCost"]));
    const rowCostPercent = parseNumber(pickRecordValue(row.record, ["costPercent", "porcentajeDeCosto", "porcentajeCosto"]));

    if (isGrandTotal) {
      grandSummary = {
        revenue: rowRevenue,
        costPercent: rowCostPercent,
        idealCostPercent: parseNumber(pickRecordValue(row.record, ["idealCostPercent", "porcentajeDeCostoIdeal", "porcentajeCostoIdeal"])),
        variancePercent: parseNumber(percentValue),
        varianceAmount: amount,
      };
      return;
    }

    if (isCategoryTotal) currentCategory = category || currentCategory;

    if (!isTotal) {
      revenue += rowRevenue;
      usedCost += rowUsedCost;
      soldCost += rowSoldCost;
      varianceTotal += amount;
    }

    if (itemName && !isTotal) {
      products.push({
        name: itemName,
        category,
        varianceAmount: amount,
        variancePercent: parseNumber(percentValue),
      });
    }

    if (isCategoryTotal) {
      categoryMap.set(category, amount);
      categoryPercentMap.set(category, parseNumber(percentValue));
    } else {
      categoryMap.set(category, (categoryMap.get(category) || 0) + amount);
    }
  });

  const categoryVariances = Array.from(categoryMap.entries()).map(([category, amount]) => ({
    category,
    amount,
    percent: categoryPercentMap.get(category) || 0,
  }));

  return {
    summary: grandSummary || {
      revenue,
      costPercent: revenue ? Number(((usedCost / revenue) * 100).toFixed(1)) : 0,
      idealCostPercent: 0,
      variancePercent: soldCost ? Number(((varianceTotal / soldCost) * 100).toFixed(1)) : 0,
      varianceAmount: varianceTotal,
    },
    categoryVariances: categoryVariances.slice(0, 8),
    topProducts: products
      .filter((item) => item.varianceAmount || item.variancePercent)
      .sort((left, right) => Math.abs(right.varianceAmount) - Math.abs(left.varianceAmount))
      .slice(0, 8),
  };
}

function extractPurchaseActuals(parsedTable) {
  return (parsedTable.rows || [])
    .map((row) => {
      const values = row.values || [];
      const item = pickRecordValue(row.record, ["itemName", "item", "product", "productName", "nombreArticulo", "nombreArtículo", "nombreArtCulo"], values[0] || "");
      const purchased = parseNumber(pickRecordValue(row.record, ["purchases", "compras", "quantityPurchased"], values[2] || ""));

      return {
        item,
        purchased,
        unit: pickRecordValue(row.record, ["unit", "udm", "uom", "unidad"], ""),
      };
    })
    .filter((row) => row.item && !/:\s*$/.test(row.item) && !/grand\s+total|^total\s+/i.test(row.item) && row.purchased)
    .sort((left, right) => Math.abs(right.purchased) - Math.abs(left.purchased));
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
  const accountName = clientInput.accountName || clientInput.organizationName || "";
  const moduleName = clientInput.moduleName || clientInput.unitName || "";
  const composedName = accountName && moduleName ? `${accountName} - ${moduleName}` : "";
  const id = clientInput.id || slugify(clientInput.name || composedName);
  let client = store.clients.find((candidate) => candidate.id === id);

  if (!client) {
    client = {
      id,
      name: clientInput.name || composedName || id,
      accountName,
      moduleName,
      cid: clientInput.cid || id,
      sculptureCid: clientInput.sculptureCid || clientInput.cid || "",
      sculptureBaseUrl: clientInput.sculptureBaseUrl || clientInput.baseUrl || "",
      area: clientInput.area || "Food",
      recipients: clientInput.recipients || [],
    };
    store.clients.push(client);
  } else {
    Object.assign(client, {
      name: clientInput.name || composedName || client.name,
      accountName: accountName || client.accountName,
      moduleName: moduleName || client.moduleName,
      cid: clientInput.cid || client.cid,
      sculptureCid: clientInput.sculptureCid || client.sculptureCid || clientInput.cid || client.cid,
      sculptureBaseUrl: clientInput.sculptureBaseUrl || clientInput.baseUrl || client.sculptureBaseUrl,
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
      pid: periodInput.pid || periodInput.sculpturePid || "",
      sculpturePid: periodInput.sculpturePid || periodInput.pid || "",
    };
    store.periods.push(period);
  } else {
    Object.assign(period, {
      label: periodInput.label || period.label,
      startsAt: periodInput.startsAt || period.startsAt,
      endsAt: periodInput.endsAt || period.endsAt,
      pid: periodInput.pid || period.pid,
      sculpturePid: periodInput.sculpturePid || period.sculpturePid || periodInput.pid || period.pid,
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

function getClickupAuth() {
  if (clickupAccessTokenCache || process.env.CLICKUP_ACCESS_TOKEN || process.env.CLICKUP_OAUTH_ACCESS_TOKEN) {
    return {
      header: `Bearer ${clickupAccessTokenCache || process.env.CLICKUP_ACCESS_TOKEN || process.env.CLICKUP_OAUTH_ACCESS_TOKEN}`,
      source: clickupAccessTokenCache ? "oauth_runtime" : "oauth_env",
    };
  }

  const personalToken = process.env.CLICKUP_API_TOKEN || process.env.VITE_CLICKUP_API_TOKEN || "";
  if (personalToken) {
    return {
      header: personalToken,
      source: "personal_token",
    };
  }

  return { header: "", source: "missing" };
}

async function exchangeClickupCode(code) {
  if (!clickupClientId || !clickupClientSecret) {
    const error = new Error("CLICKUP_CLIENT_ID and CLICKUP_CLIENT_SECRET must be configured for OAuth.");
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${clickupBaseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clickupClientId,
      client_secret: clickupClientSecret,
      code,
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.err || payload.error || `ClickUp OAuth returned ${response.status}.`);
    error.status = response.status;
    error.details = payload;
    throw error;
  }

  clickupAccessTokenCache = payload.access_token || "";
  return payload;
}

async function clickupRequest(pathname, options = {}) {
  const auth = getClickupAuth();
  if (!auth.header) {
    const error = new Error("CLICKUP_API_TOKEN or CLICKUP_ACCESS_TOKEN is not configured.");
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${clickupBaseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: auth.header,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(payload.err || payload.error || `ClickUp returned ${response.status}.`);
    error.status = response.status;
    error.details = payload;
    throw error;
  }

  return { payload, authSource: auth.source };
}

function normalizeClickupTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function normalizeClickupAssignees(value) {
  const assignees = Array.isArray(value) ? value : value ? [value] : [];
  return assignees
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function buildClickupTaskBodyFromInput(input = {}) {
  const body = {
    name: String(input.name || "").trim(),
    markdown_content: String(input.markdown_content || input.description || "").trim(),
    tags: Array.isArray(input.tags)
      ? input.tags
      : String(input.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    notify_all: false,
  };
  const assignees = normalizeClickupAssignees(input.assignees);
  const dueDate = normalizeClickupTimestamp(input.dueDate || input.due_date);

  if (input.status) body.status = String(input.status).trim();
  if (input.priority) body.priority = Number(input.priority);
  if (assignees.length) body.assignees = assignees;
  if (dueDate) {
    body.due_date = dueDate;
    body.due_date_time = Boolean(input.dueDateTime ?? input.due_date_time ?? true);
  }

  return body;
}

function buildClickupTaskBody(store, report, overrides = {}) {
  const payload = buildReportPayload(store, report);
  const clientName = payload.client?.name || report.clientId;
  const periodLabel = payload.period?.label || report.periodId;
  const taskName = `Reporte semanal Bevinco - ${clientName} - ${periodLabel}`;
  const topProducts = (payload.topProducts || [])
    .slice(0, 5)
    .map((item) => `- ${item.name} (${item.category}): ${moneyPlain(item.varianceAmount)} / ${item.variancePercent}%`)
    .join("\n");
  const suggestions = (payload.purchaseSuggestions || [])
    .slice(0, 5)
    .map((item) => `- ${item.item}: stock ${item.stock || "s/i"}, sugerido ${item.suggested || "por revisar"} (${item.provider || "proveedor por validar"})`)
    .join("\n");

  return {
    name: taskName,
    markdown_content: [
      `## ${taskName}`,
      "",
      `**Estado CMS:** ${report.status}`,
      `**Ingresos:** ${moneyPlain(payload.summary.revenue)}`,
      `**% costo:** ${payload.summary.costPercent}%`,
      `**Variance:** ${payload.summary.variancePercent}% (${moneyPlain(payload.summary.varianceAmount)})`,
      "",
      "### Resumen generado",
      payload.comments || "Reporte pendiente de generar en el CMS.",
      "",
      "### Top productos",
      topProducts || "Sin productos destacados.",
      "",
      "### Sugerencia de compra",
      suggestions || "Sin sugerencias cargadas.",
      "",
      "### Fuentes",
      Object.entries(payload.sourceStatus || {})
        .map(([source, status]) => `- ${sourceLabelsForPdf[source] || source}: ${status}`)
        .join("\n"),
    ].join("\n"),
    tags: ["bevinco", "reporte-semanal"],
    priority: 3,
    status: clickupDefaultTaskStatus,
    ...overrides,
  };
}

async function createClickupTaskForReport(store, report, listId = clickupListId, overrides = {}) {
  if (!listId) {
    const error = new Error("CLICKUP_LIST_ID is not configured.");
    error.status = 503;
    throw error;
  }

  const { payload, authSource } = await clickupRequest(`/list/${encodeURIComponent(listId)}/task`, {
    method: "POST",
    body: JSON.stringify(buildClickupTaskBody(store, report, overrides)),
  });

  report.clickupTask = {
    id: payload.id,
    url: payload.url,
    name: payload.name,
    status: payload.status?.status || payload.status,
    listId,
    authSource,
    createdAt: new Date().toISOString(),
  };
  report.updatedAt = new Date().toISOString();

  return report.clickupTask;
}

async function createClickupManualTask(taskInput = {}, listId = clickupListId) {
  if (!listId) {
    const error = new Error("CLICKUP_LIST_ID is not configured.");
    error.status = 503;
    throw error;
  }

  const body = buildClickupTaskBodyFromInput({
    status: clickupDefaultTaskStatus,
    priority: 3,
    tags: ["bevinco"],
    ...taskInput,
  });

  if (!body.name) {
    const error = new Error("Task name is required.");
    error.status = 400;
    throw error;
  }

  const { payload, authSource } = await clickupRequest(`/list/${encodeURIComponent(listId)}/task`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    ...mapClickupTask(payload),
    authSource,
  };
}

function mapClickupTask(task) {
  return {
    id: task.id,
    customId: task.custom_id,
    name: task.name,
    url: task.url,
    status: task.status?.status || "Sin estado",
    statusColor: task.status?.color || "",
    assignees: (task.assignees || []).map((assignee) => ({
      id: assignee.id,
      username: assignee.username,
      email: assignee.email,
      initials: assignee.initials,
      color: assignee.color,
    })),
    dueDate: task.due_date ? Number(task.due_date) : null,
    tags: (task.tags || []).map((tag) => tag.name || tag.tag_fg || "").filter(Boolean),
    subtasks: Array.isArray(task.subtasks) ? task.subtasks.length : Number(task.subtasks || 0),
    dateUpdated: task.date_updated ? Number(task.date_updated) : null,
  };
}

async function getClickupListMeta(listId = clickupListId) {
  if (!listId) {
    const error = new Error("CLICKUP_LIST_ID is not configured.");
    error.status = 503;
    throw error;
  }

  const [{ payload: listPayload }, { payload: membersPayload }] = await Promise.all([
    clickupRequest(`/list/${encodeURIComponent(listId)}`),
    clickupRequest(`/list/${encodeURIComponent(listId)}/member`),
  ]);

  return {
    list: {
      id: listPayload.id,
      name: listPayload.name,
      statuses: (listPayload.statuses || []).map((status) => ({
        id: status.id,
        status: status.status,
        color: status.color,
        type: status.type,
      })),
    },
    members: (membersPayload.members || []).map((member) => {
      const user = member.user || member;
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        initials: user.initials,
        color: user.color,
      };
    }),
    importantStatuses: clickupDefaultStatuses,
    defaultTaskStatus: clickupDefaultTaskStatus,
  };
}

async function getClickupTasks({
  listId = clickupListId,
  page = 0,
  statuses = clickupDefaultStatuses,
  includeClosed = true,
} = {}) {
  if (!listId) {
    const error = new Error("CLICKUP_LIST_ID is not configured.");
    error.status = 503;
    throw error;
  }

  const query = new URLSearchParams({
    include_closed: "true",
    subtasks: "true",
    order_by: "due_date",
    reverse: "false",
    page: String(Math.max(0, Number(page) || 0)),
  });
  query.set("include_closed", includeClosed ? "true" : "false");
  (Array.isArray(statuses) ? statuses : [statuses])
    .map((status) => String(status || "").trim())
    .filter(Boolean)
    .forEach((status) => query.append("statuses[]", status));

  const { payload, authSource } = await clickupRequest(`/list/${encodeURIComponent(listId)}/task?${query}`);
  const tasks = (payload.tasks || []).map(mapClickupTask);

  return {
    listId,
    authSource,
    page: Math.max(0, Number(page) || 0),
    hasMore: tasks.length >= 100,
    statuses,
    tasks,
  };
}

function uniqueSculptureConfigs(configs) {
  const seen = new Set();
  return configs.filter((config) => {
    const key = `${config.path}|${JSON.stringify(config.payload)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sculptureReportConfigs({ type, cid, pid }) {
  const configured = {
    varianceDetailed: {
      path: process.env.SCULPTURE_VARIANCE_DETAILED_PATH || "/reports/variance/overview/",
      payload: {
        cmd: process.env.SCULPTURE_VARIANCE_DETAILED_CMD || "overview",
        view: "detailed",
        cid,
        pid,
      },
    },
    varianceSummary: {
      path: process.env.SCULPTURE_VARIANCE_SUMMARY_PATH || "/reports/variance/overview/",
      payload: {
        cmd: process.env.SCULPTURE_VARIANCE_SUMMARY_CMD || "overview",
        view: "summary",
        cid,
        pid,
      },
    },
    intelipar: {
      path: process.env.SCULPTURE_INTELIPAR_PATH || "/reports/intelipar/overview/",
      payload: {
        cmd: process.env.SCULPTURE_INTELIPAR_CMD || "overview",
        cid,
        pid,
      },
    },
  }[type];

  if (!configured) return [];

  if (type === "intelipar") {
    return uniqueSculptureConfigs([
      {
        path: "/reportPar/generate",
        payload: {
          vendor: "",
          report_type: "200",
          group_by_vendor: "true",
          as_of_date: "",
          stnid: "",
        },
      },
      configured,
      { path: "/reports/intelipar/overview/", payload: { cmd: "overview", cid, pid } },
      { path: "/reports/intelipar/", payload: { cmd: "overview", cid, pid } },
      { path: "/intelipar/overview/", payload: { cmd: "overview", cid, pid } },
    ]);
  }

  const view = type === "varianceSummary" ? "summary" : "detailed";
  const grouping = type === "varianceSummary" ? "Summary" : "Detailed";
  return uniqueSculptureConfigs([
    {
      path: "/reports/generate",
      payload: {
        type: "variance",
        var_type: "category",
        grouping,
        file_format: "",
        cid,
        periodid: pid,
      },
    },
    configured,
    { path: "/reports/variance/overview/", payload: { cmd: "overview", view, cid, pid } },
    { path: "/reports/variance/overview/", payload: { cmd: "overview", detail: view, cid, pid } },
    { path: "/reports/variance/", payload: { cmd: "overview", view, cid, pid } },
    { path: "/reports/variance/overview/", payload: { cmd: "variance", view, cid, pid } },
  ]);
}

async function fetchSculptureInternalReport({ type, cid, pid, area = "Food", baseUrl = baseUrlForSculptureArea(area) }) {
  const reportConfigs = sculptureReportConfigs({ type, cid, pid });

  if (!reportConfigs.length) {
    const error = new Error("Unsupported report type.");
    error.status = 400;
    throw error;
  }

  const attempts = [];
  let referer = `${baseUrl}/`;
  const requestReport = async (cookie, reportConfig) => {
    const body = new URLSearchParams(reportConfig.payload);
    const requestUrl = new URL(reportConfig.path, baseUrl).toString();
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        accept: "text/html, */*; q=0.01",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie,
        origin: baseUrl,
        referer,
        "x-requested-with": "XMLHttpRequest",
      },
      body,
    });
    const html = await response.text();
    return { response, html, requestUrl };
  };

  let cookie = await getSculptureCookie({ baseUrl });
  try {
    const context = await activateSculptureContext({ baseUrl, cid, pid, cookie });
    cookie = context.cookie;
    referer = context.referer;
  } catch (error) {
    if (!sculptureUsername || !sculpturePassword) throw error;
    cookie = await getSculptureCookie({ forceLogin: true, baseUrl });
    const context = await activateSculptureContext({ baseUrl, cid, pid, cookie });
    cookie = context.cookie;
    referer = context.referer;
  }
  let firstEmptyResult = null;

  for (const reportConfig of reportConfigs) {
    let { response, html, requestUrl } = await requestReport(cookie, reportConfig);

    if ((response.status === 401 || response.status === 403 || looksLikeSculptureLogin(html)) && sculptureUsername && sculpturePassword) {
      cookie = await getSculptureCookie({ forceLogin: true, baseUrl });
      ({ response, html, requestUrl } = await requestReport(cookie, reportConfig));
    }

    const attempt = {
      endpoint: new URL(requestUrl).pathname,
      cmd: reportConfig.payload.cmd,
      view: reportConfig.payload.view || reportConfig.payload.detail || "",
      status: response.status,
      rowsCount: 0,
    };

    if (!response.ok) {
      attempts.push({ ...attempt, error: `HTTP ${response.status}` });
      continue;
    }

    if (looksLikeSculptureLogin(html)) {
      attempts.push({ ...attempt, error: "Login requerido" });
      continue;
    }

    const parsed = parseSculptureTable(html);
    attempt.rowsCount = parsed.rows?.length || 0;
    attempt.headersCount = parsed.headers?.length || 0;
    attempts.push(attempt);

    const result = {
      type,
      endpoint: attempt.endpoint,
      cmd: reportConfig.payload.cmd,
      view: attempt.view,
      baseUrl,
      cid,
      pid,
      attempts,
      ...parsed,
    };

    if (parsed.rows?.length) return result;
    firstEmptyResult ||= result;
  }

  if (firstEmptyResult) return firstEmptyResult;

  const error = new Error(`Sculpture no devolvio datos para ${type}.`);
  error.status = attempts.some((attempt) => attempt.error === "Login requerido") ? 401 : 502;
  error.details = JSON.stringify(attempts.slice(0, 6));
  error.attempts = attempts;
  throw error;
}

async function syncSculptureSources(store, report, requestBody = {}) {
  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const period = store.periods.find((candidate) => candidate.id === report.periodId);
  const { cid, pid, cidSource, pidSource } = resolveSculptureContext({ client, period, requestBody });
  const area = client?.area || requestBody.area || "Food";
  const baseUrl = client?.sculptureBaseUrl || client?.baseUrl || baseUrlForSculptureArea(area);
  const syncResults = {};

  if (!cid || !pid) {
    const missing = !cid ? "cid" : "pid";
    const error = `No hay ${missing} numerico configurado para Sculpture.`;
    for (const type of ["varianceDetailed", "varianceSummary", "intelipar"]) {
      syncResults[type] = { error, cid, pid };
      report.sourceStatus[type] = "Por revisar";
    }
    return syncResults;
  }

  for (const type of ["varianceDetailed", "varianceSummary", "intelipar"]) {
    try {
      const data = await fetchSculptureInternalReport({ type, cid, pid, area, baseUrl });
      syncResults[type] = {
        ...data,
        cidSource,
        pidSource,
        area,
        rowsCount: data.rows?.length || 0,
      };
      report.sourceStatus[type] = data.rows?.length ? "Sincronizado" : "Sin datos";

      if (type === "varianceDetailed" || type === "varianceSummary") {
        const metrics = extractReportMetrics(data);
        if (
          metrics.summary.revenue ||
          metrics.summary.costPercent ||
          metrics.summary.varianceAmount ||
          metrics.summary.variancePercent
        ) {
          report.summary = metrics.summary;
        }
        if (metrics.categoryVariances.length) report.categoryVariances = metrics.categoryVariances;
        if (metrics.topProducts.length) report.topProducts = metrics.topProducts;
        if (type === "varianceDetailed") {
          const purchaseActuals = extractPurchaseActuals(data);
          if (purchaseActuals.length) report.purchaseActuals = purchaseActuals;
        }
      }

      if (type === "intelipar") {
        const suggestions = data.rows.slice(0, 12).map((row) => ({
          item: pickRecordValue(row.record, ["itemName", "item", "nombreArticulo", "nombreArtículo"], row.values[0] || ""),
          provider: pickRecordValue(row.record, ["provider", "vendor", "proveedor"], row.values[11] || "Por validar"),
          stock: pickRecordValue(row.record, ["stock", "onHand", "stockActual", "existencia"], row.values[4] || ""),
          suggested: pickRecordValue(row.record, ["suggested", "order", "sugerido", "orden"], row.values[6] || ""),
          note: pickRecordValue(row.record, ["note", "nota", "excesoDeInventario", "díasRestantes"], "Revisar contra proveedor actualizado"),
        })).filter((row) => row.item && !/:\s*$/.test(row.item) && !/grand\s+total/i.test(row.item) && (row.stock || row.suggested));
        if (suggestions.length) report.purchaseSuggestions = suggestions;
      }
    } catch (error) {
      syncResults[type] = {
        error: error.message,
        details: error.details,
        attempts: error.attempts,
        cid,
        pid,
        cidSource,
        pidSource,
      };
      report.sourceStatus[type] = "Por revisar";
    }
  }

  report.updatedAt = new Date().toISOString();
  report.analysis = null;
  return syncResults;
}

function periodMonthKey(period) {
  const date = period?.startsAt || period?.endsAt || "";
  return String(date).slice(0, 7);
}

function resolvePeriodsForSculptureQuery(store, { periods = [], periodId = "", fromMonth = "", toMonth = "" } = {}) {
  const incomingPeriods = Array.isArray(periods)
    ? periods.map((period) => ensurePeriod(store, period)).filter(Boolean)
    : [];
  const availablePeriods = incomingPeriods.length ? incomingPeriods : store.periods;
  const from = String(fromMonth || "").slice(0, 7);
  const to = String(toMonth || from || "").slice(0, 7);

  if (from || to) {
    const filtered = availablePeriods.filter((period) => {
      const month = periodMonthKey(period);
      if (!month) return false;
      if (from && month < from) return false;
      if (to && month > to) return false;
      return true;
    });
    if (filtered.length) return filtered;
  }

  const selected = store.periods.find((period) => period.id === periodId) ||
    availablePeriods.find((period) => period.id === periodId) ||
    availablePeriods[0] ||
    store.periods[0];

  return selected ? [selected] : [];
}

function buildReportPayload(store, report) {
  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const period = store.periods.find((candidate) => candidate.id === report.periodId);

  const payload = {
    ...report,
    client,
    period,
    history: historyForReport(store, report),
    criteriaDocuments: store.criteriaDocuments || [],
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
      background: #eef4f3;
      color: #393939;
      font-family: "Ubuntu", "Avenir Next", Arial, Helvetica, sans-serif;
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
      background: #054372;
      border: 0;
      border-radius: 8px;
      color: #ffffff;
      cursor: pointer;
      font-weight: 700;
      min-height: 40px;
      padding: 0 14px;
    }
    header {
      background: #001e43;
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
      background: #ffffff;
      border-radius: 50%;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      grid-template-rows: repeat(2, 1fr);
      height: 42px;
      overflow: hidden;
      padding: 2px;
      width: 42px;
    }
    .brand-mark span { display: block; height: 100%; width: 100%; }
    .brand-mark span:nth-child(1) { background: #90bf4f; }
    .brand-mark span:nth-child(2) { background: #054372; }
    .brand-mark span:nth-child(3) { background: #8bc6c1; }
    .brand-mark span:nth-child(4) { background: #d6d6d6; }
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
      border-left: 4px solid #90bf4f;
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
      background: #90bf4f;
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
        <div class="brand"><div class="brand-mark"><span></span><span></span><span></span><span></span></div><div><strong>Sculpture Hospitality</strong><br><span>Reporte semanal Bevinco</span></div></div>
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
    <footer>Reporte generado por Sculpture Hospitality / Bevinco CMS. Revisar comentarios y proveedores antes del envio final.</footer>
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
  const rows = [...(history || [])].reverse();
  const width = 1080;
  const height = 340;
  const left = 72;
  const right = 48;
  const top = 36;
  const bottom = 78;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const baseline = top + chartHeight;
  const revenueBarHeight = chartHeight * 0.62;
  const percentTop = top + 18;
  const percentHeight = 92;
  const maxRevenue = Math.max(...rows.map((item) => item.revenue || 0), 1);
  const maxPercent = Math.max(40, ...rows.flatMap((item) => [item.costPercent || 0, item.idealCostPercent || 0]).map((value) => value + 8));
  const step = rows.length > 1 ? chartWidth / (rows.length - 1) : chartWidth;
  const realPoints = [];
  const idealPoints = [];
  const bars = rows
    .map((item, index) => {
      const x = left + index * step;
      const barHeight = ((item.revenue || 0) / maxRevenue) * revenueBarHeight;
      const barWidth = Math.min(78, chartWidth / Math.max(rows.length, 1) * 0.36);
      const barY = baseline - barHeight;
      const real = item.costPercent || 0;
      const ideal = item.idealCostPercent || 0;
      const realY = percentTop + percentHeight - (real / maxPercent) * percentHeight;
      const idealY = percentTop + percentHeight - (ideal / maxPercent) * percentHeight;
      const realBadgeY = Math.max(top + 2, realY - 28);
      realPoints.push(`${x},${realY}`);
      idealPoints.push(`${x},${idealY}`);

      return `
        <rect x="${x - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="#8bc6c1" />
        <text x="${x}" y="${baseline + 34}" text-anchor="middle" class="axis-label">${escapeHtml(shortPeriodLabel(item.label))}</text>
        <text x="${x}" y="${Math.max(barY + 18, top + 18)}" text-anchor="middle" class="bar-value">${compactMoney(item.revenue)}</text>
        <rect x="${x - 24}" y="${realBadgeY}" width="48" height="20" rx="4" fill="#001e43" />
        <text x="${x}" y="${realBadgeY + 14}" text-anchor="middle" class="point-label">${real.toFixed(1)}%</text>
        <circle cx="${x}" cy="${idealY}" r="4" fill="#90bf4f" />`;
    })
    .join("");
  const grid = [0, 15, 30, 45, 60].map((tick) => {
    const y = percentTop + percentHeight - (tick / 60) * percentHeight;
    return `<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#edf1f0" /><text x="${left - 12}" y="${y + 4}" text-anchor="end" class="axis-label">${tick}%</text>`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ingresos y porcentaje de costo real">
    <style>.axis-label{font:12px Ubuntu,Arial;fill:#66706d}.bar-value{font:700 12px Ubuntu,Arial;fill:#fff}.point-label{font:700 10px Ubuntu,Arial;fill:#fff}</style>
    ${grid}
    ${bars}
    <polyline points="${idealPoints.join(" ")}" fill="none" stroke="#90bf4f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="${realPoints.join(" ")}" fill="none" stroke="#001e43" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    <g transform="translate(${left + 320},${height - 16})">
      <rect width="14" height="4" fill="#8bc6c1" /><text x="20" y="4" class="axis-label">Suma de ingresos</text>
      <line x1="170" x2="196" y1="2" y2="2" stroke="#001e43" stroke-width="4" /><text x="204" y="4" class="axis-label">% costo real</text>
      <line x1="330" x2="356" y1="2" y2="2" stroke="#90bf4f" stroke-width="3" /><text x="364" y="4" class="axis-label">% costo ideal</text>
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
    const color = isNegative ? "#9f674f" : "#90bf4f";
    const textX = isNegative ? x - 6 : x + barWidth + 6;
    const textAnchor = isNegative ? "end" : "start";
    return `
      <text x="18" y="${y + 5}" class="category-label">${escapeHtml(truncateLabel(label, 34))}</text>
      <rect x="${x}" y="${y - 12}" width="${barWidth}" height="18" rx="3" fill="${color}" />
      <text x="${textX}" y="${y + 2}" text-anchor="${textAnchor}" class="amount-label">${compactMoney(amount)}</text>`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ahorro y faltantes de inventario">
    <style>.category-label{font:13px Ubuntu,Arial;fill:#66706d}.amount-label{font:700 12px Ubuntu,Arial;fill:#393939}</style>
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
      <rect x="${left}" y="${y - 12}" width="${stockWidth}" height="10" rx="3" fill="#054372" opacity="0.9" />
      <rect x="${left}" y="${y + 3}" width="${suggestedWidth}" height="10" rx="3" fill="#90bf4f" opacity="0.95" />`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Stock versus compra sugerida">
    <style>.purchase-label{font:13px Ubuntu,Arial;fill:#66706d}.purchase-value{font:700 12px Ubuntu,Arial;fill:#66706d}</style>
    <text x="${left}" y="24" class="purchase-value">Stock actual</text>
    <text x="${left + 150}" y="24" class="purchase-value" fill="#90bf4f">Compra sugerida</text>
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
    @import url("https://fonts.googleapis.com/css2?family=Ubuntu:wght@300;400;500;700&display=swap");
    @page { margin: 9mm; size: A4 landscape; }
    * { box-sizing: border-box; }
    body { background: #eef4f3; color: #393939; font-family: "Ubuntu", "Avenir Next", Arial, Helvetica, sans-serif; line-height: 1.35; margin: 0; padding: 18px; }
    .toolbar { display: flex; justify-content: flex-end; margin: 0 auto 14px; max-width: 1120px; }
    button { background: #054372; border: 0; border-radius: 6px; color: #fff; cursor: pointer; font-weight: 700; min-height: 40px; padding: 0 16px; }
    .sheet { background: #fff; border: 1px solid #d9e1df; margin: 0 auto; max-width: 1120px; min-height: 100vh; padding: 24px 30px; }
    .cover { display: grid; grid-template-columns: 108px 1fr 160px; align-items: start; gap: 22px; margin-bottom: 18px; }
    .mark-grid { display: grid; grid-template-columns: repeat(2, 42px); gap: 6px; }
    .mark-grid span { border-radius: 50%; height: 42px; }
    .mark-grid span:nth-child(1) { background: #90bf4f; }
    .mark-grid span:nth-child(2) { background: #054372; }
    .mark-grid span:nth-child(3) { background: #8bc6c1; }
    .mark-grid span:nth-child(4) { background: #d6d6d6; }
    h1 { color: #393939; font-size: 40px; letter-spacing: 0; line-height: 1; margin: 0; text-align: center; }
    .green-rule { background: #90bf4f; height: 4px; margin: 10px auto 0; max-width: 470px; }
    .period-box { border: 3px solid #90bf4f; color: #393939; display: grid; font-size: 12px; grid-template-columns: 1fr 1fr; margin-left: auto; padding: 6px; row-gap: 3px; text-align: right; }
    .period-box strong { text-align: center; grid-column: span 2; }
    .meta-line { color: #7d8582; font-size: 12px; text-align: center; margin-top: 8px; }
    .metrics { display: grid; gap: 12px; grid-template-columns: repeat(4, 1fr); margin: 16px 0 18px; }
    .metric { border: 1px solid #dde5e2; border-radius: 6px; padding: 12px; text-align: center; }
    .metric span { color: #61706c; display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .metric strong { display: block; font-size: 22px; margin-top: 5px; }
    .section { border: 1px solid #dce4e2; border-radius: 6px; margin-bottom: 16px; overflow: hidden; page-break-inside: avoid; }
    .section h2 { background: #f5f8f7; border-bottom: 1px solid #d6d6d6; color: #054372; font-size: 19px; margin: 0; padding: 12px 16px; }
    .section-body { padding: 14px 16px 16px; }
    .chart-card { border: 1px solid #e2e7e5; margin-bottom: 14px; padding: 10px; overflow: hidden; }
    .chart-card h3 { color: #909090; font-size: 18px; margin: 0 0 8px; text-align: center; }
    .chart-note { color: #5b6763; font-size: 12px; margin: 0 0 8px; }
    .report-svg { display: block; height: auto; width: 100%; }
    .two-col { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
    .summary-box { border: 1px solid #d8dfdc; color: #555; font-size: 13px; padding: 12px; white-space: pre-wrap; }
    .analysis-grid { border: 1px solid #d8dfdc; display: grid; gap: 12px; padding: 14px; }
    .analysis-block h3 { color: #054372; font-size: 15px; margin: 0 0 7px; }
    .analysis-block ul { display: grid; gap: 7px; margin: 0; padding: 0 0 0 18px; }
    .analysis-block li { color: #555; font-size: 12px; padding-left: 4px; }
    .agent-list { display: grid; gap: 8px; margin: 0; padding-left: 18px; }
    .agent-list li { color: #555; font-size: 12px; }
    .stat-stack { display: grid; gap: 16px; grid-template-columns: repeat(3, 1fr); }
    .stat-box { border: 3px solid #054372; text-align: center; }
    .stat-box h3 { background: #054372; color: #fff; font-size: 13px; margin: 0; padding: 5px; }
    .stat-box strong { color: #555; display: block; font-size: 22px; padding: 8px; }
    table { border-collapse: collapse; table-layout: fixed; width: 100%; }
    th, td { border-bottom: 1px solid #e5ebe8; font-size: 11px; overflow-wrap: anywhere; padding: 8px 10px; vertical-align: middle; }
    th { background: #f5f8f7; color: #054372; font-size: 10px; font-weight: 800; text-transform: uppercase; }
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
    .ok { color: #477626; }
    .bad { color: #9f674f; }
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
      ${renderAnalysisList("Criterios aplicados al reporte", analysis.criteriaApplied || [])}
    </div></div></section>
    <section class="section"><h2>Resumen generado por el agente de reportes</h2><div class="section-body"><div class="summary-box"><ul class="agent-list">${(analysis.agentNotes || [])
      .map((paragraph) => `<li>${escapeHtml(paragraph)}</li>`)
      .join("")}</ul></div></div></section>
    <section class="section page-break"><h2>Variaciones por categoria</h2><div class="section-body"><table><colgroup><col class="w-category-name"><col class="w-category-money"><col class="w-category-percent"></colgroup><thead><tr><th class="text-cell">Categoria</th><th class="money-cell">Monto</th><th class="percent-cell">%</th></tr></thead><tbody>${categoryRows}</tbody></table></div></section>
    <section class="section"><h2>Top productos con mayor variacion</h2><div class="section-body"><div class="chart-card">${productSvg}</div><table><colgroup><col class="w-product-name"><col class="w-product-category"><col class="w-product-money"><col class="w-product-percent"></colgroup><thead><tr><th class="text-cell">Producto</th><th class="text-cell">Categoria</th><th class="money-cell">Monto</th><th class="percent-cell">%</th></tr></thead><tbody>${productRows}</tbody></table></div></section>
    <section class="section"><h2>Sugerencia de compra Intelipar</h2><div class="section-body"><p class="chart-note">Azul: stock actual. Verde: compra sugerida por Intelipar.</p><div class="chart-card">${purchaseSvg}</div><table><colgroup><col class="w-purchase-item"><col class="w-purchase-provider"><col class="w-purchase-stock"><col class="w-purchase-suggested"><col class="w-purchase-note"></colgroup><thead><tr><th class="text-cell">Item</th><th class="text-cell">Proveedor</th><th class="small-number-cell">Stock</th><th class="small-number-cell">Sugerido</th><th class="note-cell">Nota</th></tr></thead><tbody>${purchaseRows}</tbody></table></div></section>
    <footer>Reporte generado por Sculpture Hospitality / Bevinco CMS. Revisar comentarios y proveedores antes del envio final.</footer>
  </main>
</body>
</html>`;
}

function periodSortValue(store, periodId) {
  const period = store.periods.find((candidate) => candidate.id === periodId);
  return Date.parse(period?.startsAt || period?.endsAt || "") || 0;
}

function purchaseDeviationsForReport(store, report) {
  const currentDate = periodSortValue(store, report.periodId);
  const previousReport = store.reports
    .filter((candidate) => candidate.clientId === report.clientId && candidate.id !== report.id)
    .map((candidate) => ({ report: candidate, date: periodSortValue(store, candidate.periodId) }))
    .filter((candidate) => candidate.date && (!currentDate || candidate.date < currentDate))
    .sort((left, right) => right.date - left.date)[0]?.report;

  if (!previousReport?.purchaseSuggestions?.length || !report.purchaseActuals?.length) return [];

  const actuals = new Map(
    report.purchaseActuals.map((item) => [slugify(item.item), item]),
  );

  return previousReport.purchaseSuggestions
    .map((suggestion) => {
      const actual = actuals.get(slugify(suggestion.item));
      if (!actual) return null;
      const suggested = parseNumber(suggestion.suggested);
      const purchased = parseNumber(actual.purchased);
      const deviation = purchased - suggested;

      return {
        item: suggestion.item,
        suggested,
        purchased,
        deviation,
        provider: suggestion.provider || "Por validar",
      };
    })
    .filter(Boolean)
    .filter((item) => item.suggested || item.purchased || item.deviation)
    .sort((left, right) => Math.abs(right.deviation) - Math.abs(left.deviation))
    .slice(0, 3);
}

function formatPercentDelta(value) {
  const number = Number(value || 0);
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(1)} pp`;
}

function renderTwoPageReportHtml(store, report) {
  const payload = buildReportPayload(store, report);
  const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const generatedAt = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(new Date());
  const analysis = payload.analysis || generateReportAnalysis(payload);
  const chronologicalHistory = [...(payload.history || [])].reverse();
  const currentIndex = chronologicalHistory.findIndex((item) => item.periodId === report.periodId);
  const previousPoint = currentIndex > 0 ? chronologicalHistory[currentIndex - 1] : chronologicalHistory[chronologicalHistory.length - 2];
  const costDelta = previousPoint ? (payload.summary.costPercent || 0) - (previousPoint.costPercent || 0) : 0;
  const idealCost = payload.summary.idealCostPercent || 0;
  const idealGap = idealCost ? (payload.summary.costPercent || 0) - idealCost : 0;
  const varianceClassName = (payload.summary.varianceAmount || 0) < 0 ? "bad" : "ok";
  const topCategory = [...payload.categoryVariances].sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))[0];
  const costSvg = renderCostSvg(payload.history, money);
  const varianceSvg = renderVarianceSvg(payload.categoryVariances.slice(0, 7), money);
  const productSvg = renderVarianceSvg(payload.topProducts.slice(0, 6), money);
  const deviations = purchaseDeviationsForReport(store, report);
  const executiveNotes = [
    `El periodo cierra con ${money.format(payload.summary.revenue)} en ingresos y ${payload.summary.costPercent || 0}% de costo real.`,
    idealCost ? `La brecha contra costo ideal es ${formatPercentDelta(idealGap)} y ${money.format(payload.summary.varianceAmount || 0)}.` : `La diferencia acumulada es ${money.format(payload.summary.varianceAmount || 0)}.`,
    previousPoint ? `Versus la semana anterior, el costo real cambia ${formatPercentDelta(costDelta)}.` : "No hay semana anterior suficiente para comparar tendencia.",
    topCategory ? `Mayor impacto por categoria: ${topCategory.category} (${money.format(topCategory.amount)}, ${topCategory.percent || 0}%).` : "Sin categoria dominante para este periodo.",
  ];
  const categoryRows = payload.categoryVariances.slice(0, 8).map((item) => `<tr><td>${escapeHtml(item.category)}</td><td class="num ${item.amount < 0 ? "bad" : "ok"}">${money.format(item.amount)}</td><td class="num">${item.percent || 0}%</td></tr>`).join("");
  const productRows = payload.topProducts.slice(0, 7).map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.category)}</span></td><td class="num ${item.varianceAmount < 0 ? "bad" : "ok"}">${money.format(item.varianceAmount)}</td><td class="num">${item.variancePercent || 0}%</td></tr>`).join("");
  const purchaseRows = payload.purchaseSuggestions.slice(0, 8).map((item) => `<tr><td><strong>${escapeHtml(item.item)}</strong><span>${escapeHtml(item.provider)}</span></td><td class="num">${escapeHtml(item.stock)}</td><td class="num">${escapeHtml(item.suggested)}</td><td>${escapeHtml(item.note)}</td></tr>`).join("");
  const deviationRows = deviations.length
    ? deviations.map((item) => `<tr><td><strong>${escapeHtml(item.item)}</strong><span>${escapeHtml(item.provider)}</span></td><td class="num">${item.suggested}</td><td class="num">${item.purchased}</td><td class="num ${item.deviation < 0 ? "bad" : "ok"}">${item.deviation > 0 ? "+" : ""}${item.deviation}</td></tr>`).join("")
    : `<tr><td colspan="4">Se mostrara cuando exista sugerencia de la semana anterior y compra real de la semana actual para el mismo item.</td></tr>`;
  const analysisRows = [
    ...(analysis.bestOfWeek || []).slice(0, 1),
    ...(analysis.weeklyChallenges || []).slice(0, 2),
    ...(analysis.stockEfficiency || []).slice(0, 1),
  ].map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reporte ${escapeHtml(payload.client?.name || report.clientId)}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Ubuntu:wght@300;400;500;700&display=swap");
    @page { margin: 7mm; size: A4 landscape; }
    * { box-sizing: border-box; }
    body { background: #e8efed; color: #393939; font-family: "Ubuntu", Arial, sans-serif; margin: 0; padding: 12px; }
    .toolbar { display: flex; justify-content: flex-end; margin: 0 auto 8px; max-width: 1120px; }
    .toolbar button { background: #054372; border: 0; border-radius: 6px; color: #fff; font-weight: 700; padding: 10px 16px; }
    .pdf-page { background: #fff; border: 1px solid #dce4e2; display: grid; gap: 10px; margin: 0 auto 12px; max-width: 1120px; min-height: 775px; padding: 18px 22px; page-break-after: always; }
    .pdf-page:last-child { page-break-after: auto; }
    .topbar { align-items: center; display: grid; gap: 16px; grid-template-columns: 86px 1fr 170px; }
    .mark { display: grid; gap: 5px; grid-template-columns: repeat(2, 34px); }
    .mark span { border-radius: 50%; height: 34px; }
    .mark span:nth-child(1) { background: #90bf4f; }
    .mark span:nth-child(2) { background: #054372; }
    .mark span:nth-child(3) { background: #8bc6c1; }
    .mark span:nth-child(4) { background: #d6d6d6; }
    h1 { color: #393939; font-size: 34px; line-height: 1; margin: 0; text-align: center; }
    h2 { color: #054372; font-size: 15px; margin: 0; }
    h3 { color: #054372; font-size: 12px; margin: 0 0 6px; text-transform: uppercase; }
    .rule { background: #90bf4f; height: 4px; margin: 8px auto 0; max-width: 420px; }
    .period { border: 2px solid #90bf4f; color: #526862; font-size: 11px; padding: 7px; text-align: right; }
    .period strong { color: #393939; display: block; font-size: 12px; margin-bottom: 3px; text-align: center; }
    .subline { color: #6d7a77; font-size: 11px; margin: 6px 0 0; text-align: center; }
    .metrics { display: grid; gap: 8px; grid-template-columns: 1.45fr repeat(4, 1fr); }
    .metric, .panel { border: 1px solid #dce4e2; border-radius: 6px; padding: 10px; }
    .metric span { color: #526862; display: block; font-size: 9px; font-weight: 800; text-transform: uppercase; }
    .metric strong { display: block; font-size: 20px; margin-top: 4px; }
    .grid-main { display: grid; gap: 10px; grid-template-columns: 1.4fr 0.85fr; }
    .grid-even { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
    .chart-card { border: 1px solid #e1e8e6; padding: 6px; }
    .report-svg { display: block; width: 100%; height: auto; max-height: 260px; }
    .small-chart .report-svg { max-height: 190px; }
    .notes { display: grid; gap: 6px; margin: 0; padding-left: 16px; }
    .notes li { color: #4f5d59; font-size: 11px; line-height: 1.28; }
    table { border-collapse: collapse; table-layout: fixed; width: 100%; }
    th, td { border-bottom: 1px solid #e7edeb; font-size: 10px; padding: 6px 7px; vertical-align: middle; overflow-wrap: anywhere; }
    th { background: #f6f8f7; color: #054372; font-size: 9px; font-weight: 800; text-transform: uppercase; }
    td span { color: #6d7a77; display: block; font-size: 9px; margin-top: 2px; }
    .num { text-align: right; white-space: nowrap; }
    .ok { color: #477626; }
    .bad { color: #9f674f; }
    .footer { border-top: 1px solid #dce4e2; color: #77827f; font-size: 9px; padding-top: 7px; text-align: center; }
    @media print { body { background: #fff; padding: 0; } .toolbar { display: none; } .pdf-page { border: 0; margin: 0; max-width: none; min-height: auto; } * { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Guardar como PDF</button></div>
  <section class="pdf-page">
    <header class="topbar">
      <div class="mark"><span></span><span></span><span></span><span></span></div>
      <div><h1>${escapeHtml(payload.client?.name || report.clientId)}</h1><div class="rule"></div><p class="subline">Reporte semanal Bevinco / Sculpture · ${escapeHtml(payload.client?.area || "")} · ${escapeHtml(generatedAt)}</p></div>
      <div class="period"><strong>Periodo</strong>${escapeHtml(payload.period?.label || report.periodId)}</div>
    </header>
    <section class="metrics">
      <div class="metric"><span>Ingresos</span><strong>${money.format(payload.summary.revenue || 0)}</strong></div>
      <div class="metric"><span>% costo real</span><strong>${payload.summary.costPercent || 0}%</strong></div>
      <div class="metric"><span>% costo ideal</span><strong>${idealCost || 0}%</strong></div>
      <div class="metric"><span>Diferencia % costo</span><strong class="${idealGap > 0 ? "bad" : "ok"}">${formatPercentDelta(idealGap)}</strong></div>
      <div class="metric"><span>Diferencia $$</span><strong class="${varianceClassName}">${money.format(payload.summary.varianceAmount || 0)}</strong></div>
    </section>
    <section class="grid-main">
      <div class="panel"><h2>Ingresos, costo real y costo ideal</h2><div class="chart-card">${costSvg}</div></div>
      <div class="panel"><h2>Lectura ejecutiva</h2><ul class="notes">${executiveNotes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
    </section>
    <section class="grid-even">
      <div class="panel small-chart"><h2>Ahorro/faltantes por categoria</h2>${varianceSvg}</div>
      <div class="panel"><h2>Detalle por categoria</h2><table><thead><tr><th>Categoria</th><th class="num">Monto</th><th class="num">%</th></tr></thead><tbody>${categoryRows}</tbody></table></div>
    </section>
    <div class="footer">Sculpture Hospitality / Bevinco CMS · Pagina 1 de 2</div>
  </section>
  <section class="pdf-page">
    <header class="topbar">
      <div class="mark"><span></span><span></span><span></span><span></span></div>
      <div><h1>${escapeHtml(payload.client?.name || report.clientId)}</h1><div class="rule"></div><p class="subline">Analisis operativo y compras · ${escapeHtml(payload.period?.label || report.periodId)}</p></div>
      <div class="period"><strong>Estado</strong>${escapeHtml(payload.status || "Borrador")}</div>
    </header>
    <section class="grid-even">
      <div class="panel small-chart"><h2>Top productos con mayor variacion</h2>${productSvg}</div>
      <div class="panel"><h2>Productos a revisar</h2><table><thead><tr><th>Producto</th><th class="num">Monto</th><th class="num">%</th></tr></thead><tbody>${productRows}</tbody></table></div>
    </section>
    <section class="grid-even">
      <div class="panel"><h2>Compra real vs sugerencia anterior</h2><table><thead><tr><th>Item</th><th class="num">Sugerido ant.</th><th class="num">Compra real</th><th class="num">Desv.</th></tr></thead><tbody>${deviationRows}</tbody></table></div>
      <div class="panel"><h2>Comentarios generados</h2><ul class="notes">${analysisRows || "<li>Genera el resumen del reporte para completar esta lectura.</li>"}</ul></div>
    </section>
    <section class="panel"><h2>Sugerencia de compra Intelipar</h2><table><thead><tr><th>Item / proveedor</th><th class="num">Stock</th><th class="num">Sugerido</th><th>Nota</th></tr></thead><tbody>${purchaseRows}</tbody></table></section>
    <div class="footer">Comparacion de compra: sugerencia de la semana anterior versus compra real de la semana actual cuando ambos datos existen · Pagina 2 de 2</div>
  </section>
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
  if (report) {
    await syncSculptureSources(store, report);
    await writeStore(store);
  }
  response.json({
    clients: store.clients,
    periods: store.periods,
    criteriaDocuments: store.criteriaDocuments || [],
    reports: store.reports.map((item) => buildReportPayload(store, item)),
    selectedReport: report ? buildReportPayload(store, report) : null,
  });
});

app.post("/api/module1/import-samples", requireAuth, async (_request, response) => {
  const existingStore = await readStore();
  const sampleStore = await buildStoreFromSamples();
  sampleStore.criteriaDocuments = existingStore.criteriaDocuments || [];
  await writeStore(sampleStore);
  const report = sampleStore.reports[0];
  response.json({
    clients: sampleStore.clients,
    periods: sampleStore.periods,
    criteriaDocuments: sampleStore.criteriaDocuments || [],
    reports: sampleStore.reports.map((item) => buildReportPayload(sampleStore, item)),
    selectedReport: report ? buildReportPayload(sampleStore, report) : null,
  });
});

app.post("/api/module1/criteria-documents", requireAuth, async (request, response) => {
  const store = await readStore();
  const files = Array.isArray(request.body?.files) ? request.body.files : [];

  if (!files.length) {
    response.status(400).json({ error: "At least one criteria file is required." });
    return;
  }

  const documents = files.map((file) => {
    const text = String(file.text || "").replace(/\0/g, "").trim();
    const name = String(file.name || "criterio.txt").trim();

    return {
      id: `${Date.now()}-${crypto.randomUUID()}`,
      name,
      type: String(file.type || "text/plain"),
      text: text.slice(0, 30000),
      size: Number(file.size || text.length || 0),
      uploadedAt: new Date().toISOString(),
    };
  });

  store.criteriaDocuments = [...documents, ...(store.criteriaDocuments || [])].slice(0, 30);
  store.reports.forEach((report) => {
    report.analysis = null;
  });
  await writeStore(store);

  response.json({
    clients: store.clients,
    periods: store.periods,
    criteriaDocuments: store.criteriaDocuments,
    reports: store.reports.map((item) => buildReportPayload(store, item)),
    selectedReport: store.reports[0] ? buildReportPayload(store, store.reports[0]) : null,
  });
});

app.delete("/api/module1/criteria-documents/:documentId", requireAuth, async (request, response) => {
  const store = await readStore();
  store.criteriaDocuments = (store.criteriaDocuments || []).filter((document) => document.id !== request.params.documentId);
  store.reports.forEach((report) => {
    report.analysis = null;
  });
  await writeStore(store);

  response.json({
    clients: store.clients,
    periods: store.periods,
    criteriaDocuments: store.criteriaDocuments,
    reports: store.reports.map((item) => buildReportPayload(store, item)),
    selectedReport: store.reports[0] ? buildReportPayload(store, store.reports[0]) : null,
  });
});

app.post("/api/module1/clients", requireAuth, async (request, response) => {
  const store = await readStore();
  const client = ensureClient(store, request.body || {});
  await writeStore(store);
  response.json({ client, clients: store.clients });
});

app.get("/api/module1/sculpture-units", requireAuth, async (_request, response) => {
  try {
    const payload = await discoverSculptureUnits();
    response.json(payload);
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "Unable to discover Sculpture units.",
      details: error.details,
    });
  }
});

app.post("/api/module1/sculpture-units/import", requireAuth, async (request, response) => {
  const store = await readStore();
  const unit = request.body || {};

  if (!unit.sculptureCid && !unit.cid) {
    response.status(400).json({ error: "Sculpture cid is required." });
    return;
  }

  const client = ensureClient(store, {
    ...unit,
    cid: unit.sculptureCid || unit.cid,
    sculptureCid: unit.sculptureCid || unit.cid,
    sculptureBaseUrl: unit.baseUrl || unit.sculptureBaseUrl || baseUrlForSculptureArea(unit.area),
    recipients: unit.recipients || [],
  });
  const periodId = unit.periodId && store.periods.some((period) => period.id === unit.periodId)
    ? unit.periodId
    : store.periods[0]?.id;
  const report = reportForClientPeriod(store, client.id, periodId || defaultPid);
  await writeStore(store);

  response.json({
    client,
    clients: store.clients,
    selectedReport: buildReportPayload(store, report),
    reports: store.reports.map((item) => buildReportPayload(store, item)),
  });
});

app.post("/api/module1/sculpture/query", requireAuth, async (request, response) => {
  const store = await readStore();
  const { unit, clientId, periodId, fromMonth, toMonth, periods: incomingPeriods = [] } = request.body || {};
  const resolvedUnit = unit || store.clients.find((candidate) => candidate.id === clientId);

  if (!resolvedUnit) {
    response.status(400).json({ error: "Selecciona un restaurante/local de Sculpture para consultar." });
    return;
  }

  const sculptureCid = configuredIdentifier(resolvedUnit.sculptureCid, resolvedUnit.cid);
  if (!sculptureCid) {
    response.status(400).json({ error: "El restaurante/local seleccionado no tiene CID numerico de Sculpture." });
    return;
  }

  const client = ensureClient(store, {
    ...resolvedUnit,
    cid: sculptureCid,
    sculptureCid,
    sculptureBaseUrl: resolvedUnit.baseUrl || resolvedUnit.sculptureBaseUrl || baseUrlForSculptureArea(resolvedUnit.area),
    recipients: resolvedUnit.recipients || [],
  });
  let sculptureClientPeriods = [];
  try {
    sculptureClientPeriods = await fetchSculpturePeriodsForClient({
      baseUrl: client.sculptureBaseUrl || baseUrlForSculptureArea(client.area),
      cid: sculptureCid,
    });
  } catch {
    sculptureClientPeriods = [];
  }
  const selectedPeriods = resolvePeriodsForSculptureQuery(store, {
    periods: sculptureClientPeriods.length ? sculptureClientPeriods : incomingPeriods,
    periodId,
    fromMonth,
    toMonth,
  });

  if (!selectedPeriods.length) {
    response.status(400).json({ error: "No hay periodos disponibles para el rango seleccionado." });
    return;
  }

  const queriedReports = [];
  const syncResultsByPeriod = {};

  for (const period of selectedPeriods) {
    const report = reportForClientPeriod(store, client.id, period.id);
    const syncResults = await syncSculptureSources(store, report, {
      cid: sculptureCid,
      pid: period.sculpturePid || period.pid,
      area: client.area,
    });
    syncResultsByPeriod[period.id] = syncResults;
    queriedReports.push(buildReportPayload(store, report));
  }

  await writeStore(store);

  response.json({
    client,
    clients: store.clients,
    periods: store.periods,
    selectedReport: queriedReports[0] || null,
    queriedReports,
    reports: store.reports.map((item) => buildReportPayload(store, item)),
    syncResultsByPeriod,
  });
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
  const shouldSync = request.query.sync !== "false";
  const report = reportForClientPeriod(store, clientId, periodId);
  const syncResults = shouldSync ? await syncSculptureSources(store, report) : {};
  await writeStore(store);
  response.json({
    report: buildReportPayload(store, report),
    syncResults,
  });
});

app.post("/api/module1/sync", requireAuth, async (request, response) => {
  const store = await readStore();
  const { clientId, periodId } = request.body || {};
  const client = store.clients.find((candidate) => candidate.id === clientId);
  const period = store.periods.find((candidate) => candidate.id === periodId);

  if (!client) {
    response.status(404).json({ error: "Client not found." });
    return;
  }

  const report = reportForClientPeriod(store, clientId, periodId);
  const syncResults = await syncSculptureSources(store, report, {
    ...request.body,
    cid: client.sculptureCid || client.cid,
    pid: period?.sculpturePid || period?.pid,
  });
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
  await syncSculptureSources(store, report);
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
  response.send(renderTwoPageReportHtml(store, report));
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

app.get("/api/clickup/status", requireAuth, async (_request, response) => {
  const auth = getClickupAuth();
  const status = {
    configured: Boolean(auth.header),
    authSource: auth.source,
    listIdConfigured: Boolean(clickupListId),
    connected: false,
    user: null,
    error: "",
  };

  if (!auth.header) {
    response.json(status);
    return;
  }

  try {
    const { payload } = await clickupRequest("/user");
    status.connected = true;
    status.user = payload.user || payload;
    response.json(status);
  } catch (error) {
    status.error = error.message || "Unable to connect to ClickUp.";
    response.json(status);
  }
});

app.post("/api/clickup/oauth/token", requireAuth, async (request, response) => {
  const code = String(request.body?.code || "").trim();

  if (!code) {
    response.status(400).json({ error: "ClickUp OAuth code is required." });
    return;
  }

  try {
    const payload = await exchangeClickupCode(code);
    response.json({
      connected: Boolean(payload.access_token),
      tokenType: payload.token_type || "bearer",
    });
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "Unable to exchange ClickUp OAuth code.",
      details: error.details,
    });
  }
});

app.get("/api/clickup/tasks", requireAuth, async (request, response) => {
  try {
    const requestedStatuses = request.query.status === "all"
      ? []
      : Array.isArray(request.query.status)
        ? request.query.status
        : request.query.status
          ? [request.query.status]
          : clickupDefaultStatuses;
    const tasksPayload = await getClickupTasks({
      listId: request.query.listId || clickupListId,
      page: request.query.page || 0,
      statuses: requestedStatuses,
      includeClosed: request.query.includeClosed !== "false",
    });
    response.json(tasksPayload);
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "Unable to load ClickUp tasks.",
      details: error.details,
    });
  }
});

app.get("/api/clickup/meta", requireAuth, async (request, response) => {
  try {
    response.json(await getClickupListMeta(request.query.listId || clickupListId));
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "Unable to load ClickUp metadata.",
      details: error.details,
    });
  }
});

app.post("/api/clickup/tasks", requireAuth, async (request, response) => {
  try {
    const task = await createClickupManualTask(request.body || {}, request.body?.listId || clickupListId);
    response.json({ task });
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "Unable to create ClickUp task.",
      details: error.details,
    });
  }
});

app.post("/api/clickup/reports/:reportId/task", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).json({ error: "Report not found." });
    return;
  }

  try {
    const task = await createClickupTaskForReport(store, report, request.body?.listId || clickupListId, request.body?.task || {});
    await writeStore(store);
    response.json({ task, report: buildReportPayload(store, report) });
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "Unable to create ClickUp task.",
      details: error.details,
    });
  }
});

const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distPath, "index.html"));
});

app.listen(port, () => {
  console.log(`Bevinco CMS listening on port ${port}`);
});
