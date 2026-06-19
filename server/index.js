import path from "node:path";
import crypto from "node:crypto";
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

app.use(express.json());

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

const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distPath, "index.html"));
});

app.listen(port, () => {
  console.log(`Bevinco CMS listening on port ${port}`);
});
