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

// Timeout global para todas las llamadas salientes (Sculpture puede quedarse
// colgado sin responder y sin esto la peticion del CMS nunca termina).
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) =>
  nativeFetch(input, { signal: init.signal || AbortSignal.timeout(45000), ...init });

const app = express();
const port = process.env.PORT || 3000;

// ===== Persistencia del store en Supabase =====
// El disco de Render es efimero: sin esto, los reportes/criterios/usuarios se
// pierden en cada deploy o reinicio. El store completo se respalda como JSON
// en la tabla cms_store y se restaura al arrancar.
const supabaseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  "";
const supabaseConfigured = Boolean(supabaseUrl && supabaseKey);
let hydrationPromise = null;
const supabaseStatus = {
  configured: supabaseConfigured,
  restored: false,
  lastOkAt: "",
  lastError: supabaseConfigured ? "" : "Sin configurar: los datos no sobreviven reinicios del servidor.",
};

function supabaseHeaders() {
  return {
    apikey: supabaseKey,
    authorization: `Bearer ${supabaseKey}`,
    "content-type": "application/json",
  };
}

function hydrateStoreFromSupabase() {
  if (!supabaseConfigured) return Promise.resolve();
  // Promesa compartida: TODAS las peticiones del arranque esperan la misma
  // hidratacion. Sin esto, una escritura temprana (login dispara varias
  // peticiones en paralelo) pisaba el respaldo remoto con el store de muestras.
  if (!hydrationPromise) hydrationPromise = performSupabaseHydration();
  return hydrationPromise;
}

async function performSupabaseHydration() {
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/cms_store?id=eq.1&select=data`, {
      headers: supabaseHeaders(),
    });
    if (!response.ok) {
      supabaseStatus.lastError = `Lectura rechazada (${response.status}). Revisa URL, clave service_role y la tabla cms_store.`;
      console.error("[supabase] lectura fallo:", response.status, (await response.text()).slice(0, 200));
      return;
    }
    const rows = await response.json();
    const remote = rows?.[0]?.data;
    if (remote && typeof remote === "object" && Array.isArray(remote.reports)) {
      await fsPromisesMkdir();
      const tempPath = `${moduleStorePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(remote, null, 2));
      await fs.rename(tempPath, moduleStorePath);
      supabaseStatus.restored = true;
      supabaseStatus.lastOkAt = new Date().toISOString();
      console.log(`[supabase] store restaurado (${remote.reports.length} reportes, ${(remote.criteriaDocuments || []).length} criterios)`);
    } else {
      supabaseStatus.lastOkAt = new Date().toISOString();
      console.log("[supabase] sin respaldo previo; se creara al primer guardado");
    }
  } catch (error) {
    supabaseStatus.lastError = `No se pudo restaurar el respaldo: ${error.message}`;
    console.error("[supabase] no se pudo hidratar el store:", error.message);
  }
}

async function fsPromisesMkdir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function persistStoreToSupabase(store) {
  if (!supabaseConfigured) return;
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/cms_store?on_conflict=id`, {
      method: "POST",
      headers: { ...supabaseHeaders(), prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ id: 1, data: store, updated_at: new Date().toISOString() }]),
    });
    if (!response.ok) {
      supabaseStatus.lastError = `Escritura rechazada (${response.status}). Revisa que la clave sea la service_role.`;
      console.error("[supabase] escritura fallo:", response.status, (await response.text()).slice(0, 200));
    } else {
      supabaseStatus.lastError = "";
      supabaseStatus.lastOkAt = new Date().toISOString();
    }
  } catch (error) {
    supabaseStatus.lastError = `No se pudo respaldar: ${error.message}`;
    console.error("[supabase] no se pudo respaldar el store:", error.message);
  }
}

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
const cmsSuperadminEmail = (process.env.CMS_SUPERADMIN_EMAIL || "gerencia@bevinco.com").toLowerCase();
const sessionSecret = process.env.CMS_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const openaiApiKey = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || "";
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
// El chat es interactivo y de bajo volumen: usa el modelo completo, que sigue
// instrucciones y ejemplos pegados con mucha mas fidelidad que el mini.
const openaiChatModel = process.env.OPENAI_CHAT_MODEL || "gpt-4.1";
const sessionCookieName = "bevinco_session";
const dataDir = path.resolve(__dirname, "../data");
const moduleStorePath = path.join(dataDir, "module1.json");
const publicDir = path.resolve(__dirname, "public");
const sculptureSessionCookieCache = new Map();
let clickupAccessTokenCache = "";
let cachedLogoDataUri = "";

// Renderiza el reporte de dos paginas como PDF real usando Chromium headless.
// En Render (Linux) usa @sparticuz/chromium (binario liviano para servidores);
// en desarrollo Windows usa el Chrome instalado.
let pdfBrowserPromise = null;
// Chromium consume ~300MB: mantenerlo vivo para siempre reventaba los 512MB
// de la instancia de Render (OOM del 29-jul). Se cierra tras un minuto sin
// uso; el siguiente PDF paga ~3s de arranque a cambio de liberar la memoria.
let pdfBrowserIdleTimer = null;
const PDF_BROWSER_IDLE_MS = 60_000;

function schedulePdfBrowserClose() {
  clearTimeout(pdfBrowserIdleTimer);
  pdfBrowserIdleTimer = setTimeout(async () => {
    const closingPromise = pdfBrowserPromise;
    pdfBrowserPromise = null;
    try {
      const browser = await closingPromise;
      await browser?.close();
      console.log("[pdf] Chromium cerrado por inactividad");
    } catch {
      // Ya estaba muerto: nada que liberar.
    }
  }, PDF_BROWSER_IDLE_MS);
}

async function getPdfBrowser() {
  if (!pdfBrowserPromise) {
    pdfBrowserPromise = (async () => {
      const puppeteer = (await import("puppeteer-core")).default;
      if (process.platform === "win32") {
        return puppeteer.launch({
          executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
          headless: true,
        });
      }
      const chromium = (await import("@sparticuz/chromium")).default;
      return puppeteer.launch({
        args: [...chromium.args, "--disable-gpu", "--no-zygote"],
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    })().catch((error) => {
      pdfBrowserPromise = null;
      throw error;
    });
  }
  return pdfBrowserPromise;
}

async function renderReportPdf(store, report, attempt = 0) {
  const html = renderTwoPageReportHtml(store, report);
  // No cerrar el navegador mientras hay un PDF en curso.
  clearTimeout(pdfBrowserIdleTimer);
  let browser;
  try {
    browser = await getPdfBrowser();
    if (!browser.connected) throw new Error("browser desconectado");
  } catch (error) {
    // El navegador pudo morir (memoria/reinicio): resetear y reintentar una vez.
    pdfBrowserPromise = null;
    if (attempt < 1) return renderReportPdf(store, report, attempt + 1);
    console.error("[pdf] launch fallo:", error.stack || error.message);
    throw error;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      // El lienzo del reporte mide ~810px y el A4 util ~740px: se escala para
      // que cada pagina del reporte entre exacta en una hoja.
      scale: 0.88,
      margin: { top: "7mm", bottom: "7mm", left: "6mm", right: "6mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
    schedulePdfBrowserClose();
  }
}

// Plantilla de correo (compatible con Gmail/Outlook: tablas + estilos inline).
// Envio por Gmail/Workspace (SMTP con contraseña de aplicación). Si esta
// configurado, tiene prioridad sobre Resend: sale desde la casilla real del
// equipo, con la reputación del dominio ya establecida y sin tocar DNS.
const gmailUser = process.env.GMAIL_USER || "";
const gmailAppPassword = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const gmailConfigured = Boolean(gmailUser && gmailAppPassword);
let gmailTransportPromise = null;

async function getGmailTransport() {
  if (!gmailTransportPromise) {
    gmailTransportPromise = (async () => {
      const nodemailer = (await import("nodemailer")).default;
      return nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: gmailUser, pass: gmailAppPassword },
      });
    })();
  }
  return gmailTransportPromise;
}

function renderEmailShellHtml({ clientName, bodyText }) {
  const paragraphs = String(bodyText || "")
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px;color:#333333;font-size:14.5px;line-height:1.65;">${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef2f1;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f1;padding:26px 12px;">
    <tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dce4e2;">
        <tr>
          <td style="height:5px;background:linear-gradient(90deg,#054372 0%,#90bf4f 55%,#8bc6c1 100%);font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td align="center" style="padding:30px 40px 6px;">
            <div style="font-family:Ubuntu,'Segoe UI',Arial,sans-serif;font-weight:700;font-size:20px;color:#054372;letter-spacing:0.4px;">BEVINCO</div>
            <div style="font-family:Ubuntu,'Segoe UI',Arial,sans-serif;font-size:11px;color:#8ba39c;letter-spacing:2px;text-transform:uppercase;margin-top:2px;">Sculpture Hospitality</div>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 40px 8px;font-family:Ubuntu,'Segoe UI',Arial,sans-serif;">
            ${paragraphs}
          </td>
        </tr>
        <tr>
          <td style="padding:4px 40px 28px;font-family:Ubuntu,'Segoe UI',Arial,sans-serif;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="background:#f5f8f7;border:1px solid #e2eae7;border-radius:10px;width:100%;">
              <tr>
                <td style="padding:12px 16px;color:#526862;font-size:13px;line-height:1.5;">
                  📎 El reporte completo de <strong style="color:#054372;">${escapeHtml(clientName)}</strong> va adjunto en PDF, con los gráficos y el detalle por producto.
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 40px 26px;font-family:Ubuntu,'Segoe UI',Arial,sans-serif;color:#8ba39c;font-size:11.5px;border-top:1px solid #eef2f1;padding-top:16px;">
            Reporte generado por Bevinco CMS · Sculpture Hospitality
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function logoDataUri() {
  if (cachedLogoDataUri) return cachedLogoDataUri;
  const candidates = [
    path.join(publicDir, "logo.png"),
    path.resolve(__dirname, "../public/logo.png"),
    path.resolve(__dirname, "../dist/logo.png"),
  ];
  for (const candidate of candidates) {
    try {
      const buffer = fsSync.readFileSync(candidate);
      cachedLogoDataUri = `data:image/png;base64,${buffer.toString("base64")}`;
      return cachedLogoDataUri;
    } catch {
      // Probar la siguiente ubicacion.
    }
  }
  return "";
}

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
      // Semilla de demostracion construida desde los CSV de server/public/.
      // NO tiene cid real en Sculpture: antes heredaba defaultCid (29088), que
      // es el cid de Azotea cocina, y apuntaba a otro restaurante.
      sculptureCid: "",
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
      // Semilla de demostracion: ver nota en bardot-barra.
      sculptureCid: "",
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

const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

function createSessionToken(username) {
  const payload = Buffer.from(
    JSON.stringify({
      ...(typeof username === "string" ? { username } : username),
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    }),
  ).toString("base64url");

  return `${payload}.${signPayload(payload)}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [salt, hash] = String(passwordHash || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  return timingSafeEqual(candidate, hash);
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function sessionUserPayload(user) {
  return {
    id: user.id,
    username: user.email || user.username || user.name,
    name: user.name || user.email || user.username,
    email: user.email || "",
    role: user.role || "Usuario",
    permissions: user.permissions || [],
  };
}

function isSuperadminIdentity(value) {
  const login = String(value || "").toLowerCase();
  return Boolean(login && (login === cmsSuperadminEmail || login === String(authUsername || "").toLowerCase()));
}

function enrichSession(session) {
  if (!session) return null;
  if (session.role === "Superadmin" || isSuperadminIdentity(session.email) || isSuperadminIdentity(session.username)) {
    return {
      ...session,
      id: session.id || "env-superadmin",
      username: session.username || cmsSuperadminEmail,
      name: session.name || "Gerencia Bevinco",
      email: session.email || cmsSuperadminEmail,
      role: "Superadmin",
      permissions: ["dashboard", "module1", "tasks", "reports", "criteria", "users"],
    };
  }
  return session;
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
    return enrichSession(session);
  } catch {
    return null;
  }
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function requireAuth(request, response, next) {
  const session = readSession(request);
  if (!session) {
    // Los links que se abren en otra pestaña (PDF, export, CSV) llegan como
    // navegacion del browser: con la sesion vencida se redirige al login en
    // vez de mostrar el JSON crudo de error.
    if (request.method === "GET" && String(request.headers.accept || "").includes("text/html")) {
      response.redirect(302, "/");
      return;
    }
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  // Renovacion deslizante: si la sesion ya consumio mas de un dia, se
  // reemite la cookie para que el equipo no vuelva a encontrarse con
  // "Authentication required" a mitad de semana.
  if ((session.expiresAt || 0) - Date.now() < SESSION_LIFETIME_MS - 1000 * 60 * 60 * 24) {
    const { expiresAt, ...user } = session;
    response.setHeader("Set-Cookie", sessionCookie(createSessionToken(user)));
  }

  request.session = session;
  next();
}

function requirePermission(permission) {
  return (request, response, next) => {
    const session = request.session || readSession(request);
    const permissions = session?.permissions || [];
    if (session?.role === "Superadmin" || permissions.includes(permission)) {
      request.session = session;
      next();
      return;
    }
    response.status(403).json({ error: "No tienes permisos para acceder a este modulo." });
  };
}

function normalizeHeader(value) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    // Sin esto, "Usado (Costo)" generaba la clave rota "usadoCosto)" y ninguna
    // columna de costos calzaba al leer los reportes de Sculpture.
    .replace(/[^a-zA-Z0-9]+$/g, "")
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
  // La cache guarda cookies de logins recientes; tiene prioridad sobre la
  // cookie fija del entorno, que puede haber vencido.
  if (!forceLogin && sculptureSessionCookieCache.get(baseUrl)) return sculptureSessionCookieCache.get(baseUrl);
  if (!forceLogin && process.env.SCULPTURE_SESSION_COOKIE) return process.env.SCULPTURE_SESSION_COOKIE;

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
  // Soporta "Jun 4 to Jun 10 2026" y tambien "Dec 29 2025 to Jan 6 2026"
  // (el anio puede venir en el tramo inicial cuando el periodo cruza de anio).
  const match = text.match(
    /([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+(\d{1,2})(?:\s+(\d{4}))?\s+(?:to|al|-)\s+(?:([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+)?(\d{1,2})\s+(\d{4})/i,
  );
  if (!match) return { startsAt: "", endsAt: "" };

  const [, startMonthName, startDay, startYearRaw, endMonthName, endDay, endYear] = match;
  const startMonth = normalizeMonthName(startMonthName);
  const endMonth = normalizeMonthName(endMonthName || startMonthName);
  if (!startMonth || !endMonth) return { startsAt: "", endsAt: "" };
  const startYear = startYearRaw || endYear;

  return {
    startsAt: `${startYear}-${startMonth}-${String(startDay).padStart(2, "0")}`,
    endsAt: `${endYear}-${endMonth}-${String(endDay).padStart(2, "0")}`,
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
  try {
    return await activateSculptureContextOnce({ baseUrl, cid, pid, cookie });
  } catch (error) {
    // La cookie de sesion (env o cache) puede estar vencida: reintentar una
    // vez con login fresco, igual que hace fetchSculpturePage.
    if (!cookie && sculptureUsername && sculpturePassword) {
      const freshCookie = await getSculptureCookie({ forceLogin: true, baseUrl });
      return activateSculptureContextOnce({ baseUrl, cid, pid, cookie: freshCookie });
    }
    throw error;
  }
}

async function activateSculptureContextOnce({ baseUrl, cid, pid = "", cookie }) {
  let sessionCookie = cookie || (await getSculptureCookie({ baseUrl }));
  let referer = `${baseUrl}/`;

  const visit = async (pagePath) => {
    let url = new URL(pagePath, baseUrl).toString();
    let response;
    let html = "";

    // El cambio de cliente/periodo responde con redirecciones 302; hay que
    // seguirlas manualmente para conservar las cookies de sesion.
    for (let hop = 0; hop < 6; hop += 1) {
      response = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          cookie: sessionCookie,
          referer,
        },
        redirect: "manual",
      });
      sessionCookie = mergeCookieHeaders(sessionCookie, getSetCookieHeaders(response));
      referer = url;

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        url = new URL(response.headers.get("location"), url).toString();
        continue;
      }

      html = await response.text();
      break;
    }

    if (!response?.ok || looksLikeSculptureLogin(html)) {
      const error = new Error(`Unable to activate Sculpture context ${pagePath}.`);
      error.status = response?.status || 401;
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
  const { html, cookie, referer } = await activateSculptureContext({ baseUrl, cid });
  const periods = new Map();
  const collect = (pageHtml) => {
    parseSculpturePeriodsFromHtml(pageHtml).forEach((period) => {
      periods.set(period.pid, { ...period, id: `sculpture-${cid}-${period.pid}` });
    });
  };
  collect(html);

  // La portada solo muestra algunos periodos; el selector completo vive en las
  // paginas de reportes, asi que se recorren tambien para armar la lista total.
  for (const extraPath of ["/reports/variance/", "/reports/variance/overview/", "/finalizeperiod/"]) {
    try {
      const response = await fetch(new URL(extraPath, baseUrl).toString(), {
        headers: { accept: "text/html,application/xhtml+xml", cookie, referer },
      });
      if (response.ok) {
        const pageHtml = await response.text();
        if (!looksLikeSculptureLogin(pageHtml)) collect(pageHtml);
      }
    } catch {
      // Pagina opcional: se ignora si falla.
    }
  }

  return [...periods.values()].sort((left, right) =>
    String(right.startsAt || right.label).localeCompare(String(left.startsAt || left.label)),
  );
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
  // SIN defaults al final de la cadena. defaultCid es 29088 (el cid real de
  // Azotea cocina) y defaultPid es 36 ("Jun 4 to Jun 10 2026"): cuando caian
  // ahi, un cliente o un periodo mal configurado sincronizaba OTRO restaurante
  // u OTRA semana y quedaba rotulado "Sincronizado". Ahora devuelve cadena
  // vacia y syncSculptureSources corta con el error explicito que ya tiene
  // escrito. Medido: 0 de 22 clientes pierden sync, 118 de 123 reportes siguen
  // sincronizables; los 5 que fallan son los 5 mensuales, que HOY "funcionan"
  // trayendo la semana equivocada.
  const cid = configuredIdentifier(
    requestBody.cid,
    requestBody.sculptureCid,
    client?.sculptureCid,
    client?.cid,
  );
  const pid = configuredIdentifier(
    requestBody.pid,
    requestBody.sculpturePid,
    period?.sculpturePid,
    period?.pid,
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
  await hydrateStoreFromSupabase();
  await ensureStore();
  const raw = await fs.readFile(moduleStorePath, "utf8");
  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    // Archivo corrupto (corte a mitad de escritura): respaldar y reconstruir
    // con las muestras en lugar de tumbar todas las peticiones.
    await fs.rename(moduleStorePath, `${moduleStorePath}.corrupt-${Date.now()}`).catch(() => {});
    const rebuilt = await buildStoreFromSamples();
    await fs.writeFile(moduleStorePath, JSON.stringify(rebuilt, null, 2));
    store = rebuilt;
  }
  store.clients ||= [];
  store.periods ||= [];
  store.reports ||= [];
  store.criteriaDocuments ||= [];
  store.users ||= [];
  store.hiddenSculptureUnits ||= [];
  store.presence ||= {};
  return store;
}

async function writeStore(store) {
  await fs.mkdir(dataDir, { recursive: true });
  // Escritura atomica: evita que una lectura concurrente (o un reinicio a
  // mitad de escritura) vea el JSON truncado.
  const tempPath = `${moduleStorePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2));
  await fs.rename(tempPath, moduleStorePath);
  await persistStoreToSupabase(store);
}

function findReport(store, reportId) {
  return store.reports.find((report) => report.id === reportId);
}

function lastFourPeriods(store, report) {
  // Historico POR CLIENTE: los periodos del store son globales (varios
  // restaurantes comparten rangos), asi que solo cuentan el periodo del
  // reporte y los periodos donde ESTE cliente tiene reporte guardado.
  // Se excluyen los sinteticos mensuales y se ordena por fecha.
  const clientPeriodIds = new Set(
    store.reports.filter((item) => item.clientId === report.clientId).map((item) => item.periodId),
  );
  const seenStarts = new Set();
  const weekly = store.periods
    .filter((period) => period.source !== "mensual" && !String(period.id).startsWith("mensual-"))
    .filter((period) => period.id === report.periodId || clientPeriodIds.has(period.id))
    .sort((left, right) => String(left.startsAt || left.label).localeCompare(String(right.startsAt || right.label)))
    .filter((period) => {
      const key = period.startsAt || period.label;
      if (seenStarts.has(key)) return false;
      seenStarts.add(key);
      return true;
    });
  const selectedIndex = weekly.findIndex((period) => period.id === report.periodId);
  if (selectedIndex === -1) return weekly.slice(-4);
  return weekly.slice(Math.max(0, selectedIndex - 3), selectedIndex + 1);
}

// Historial de las ultimas 4 semanas usando SOLO datos reales sincronizados.
// Un reporte de auditoria no puede inventar cifras: si una semana no fue
// consultada, sus valores quedan en 0 y los graficos la omiten.
function historyForReport(store, report) {
  const periods = lastFourPeriods(store, report);
  return periods.map((period) => {
    const existing = store.reports.find(
      (candidate) => candidate.clientId === report.clientId && candidate.periodId === period.id,
    );
    const summarySource = existing?.summary || (period.id === report.periodId ? report.summary : null);

    return {
      periodId: period.id,
      label: period.label,
      endsAt: period.endsAt || "",
      revenue: summarySource?.revenue || 0,
      costPercent: summarySource?.costPercent || 0,
      idealCostPercent: summarySource?.idealCostPercent || 0,
      varianceAmount: summarySource?.varianceAmount || 0,
      usedCost: summarySource?.usedCost || Math.round(((summarySource?.costPercent || 0) / 100) * (summarySource?.revenue || 0)),
      inventoryCost: summarySource?.inventoryCost || 0,
      purchasedCost: summarySource?.purchasedCost || 0,
      suggestedCost: summarySource?.suggestedCost || 0,
    };
  });
}

function parseNumber(value) {
  let normalized = String(value || "")
    .replace(/[$,%]/g, "")
    .replace(/\s/g, "")
    .trim();

  const isNegative = normalized.startsWith("-") || normalized.startsWith("−") || normalized.startsWith("(");
  normalized = normalized.replace(/[()+−-]/g, "");

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

// Agrupa las subcategorias del variance (Vodka, Chardonnay, Schop...) en las
// 6 familias que usa el reporte Bevinco. "Otros" solo aparece si tiene monto.
const REPORT_FAMILIES = ["Destilados", "Vinos", "Espumantes", "Cervezas y Sidra", "Barriles", "Sin Alcohol"];

function familyForCategory(name) {
  const text = String(name || "").toLowerCase();
  if (/schop|barril/.test(text)) return "Barriles";
  if (/espumante|champagne|sparkling|prosecco|brut|spritz/.test(text)) return "Espumantes";
  if (/cerveza|sidra|beer|cider/.test(text)) return "Cervezas y Sidra";
  if (/agua|bebida|energizante|kombucha|jugo|gaseosa|sin alcohol|s\/alcohol|cafe|café|leche|nectar|néctar/.test(text)) return "Sin Alcohol";
  if (/cabernet|carmenere|carménère|chardonnay|merlot|pinot|sauvignon|syrah|ensamblaje|late harvest|vino|rosé|rose\b|blend|malbec|riesling|viognier|moscato|torontel|cinsault|garnacha|tempranillo|zinfandel|petit|sangria|sangría/.test(text)) return "Vinos";
  if (/whisk|bourbon|scotch|irish|vodka|gin\b|ron\b|rum\b|tequila|mezcal|pisco|licor|aperitivo|vermouth|vermut|brandy|cognac|cachaca|cachaça|destilado|amargo|bitter|anis|anís|grappa|sake|soju|absenta|premium/.test(text)) return "Destilados";
  return "Otros";
}

function aggregateByFamily(entries) {
  const map = new Map(REPORT_FAMILIES.map((family) => [family, 0]));
  for (const { category, value } of entries) {
    const family = familyForCategory(category);
    map.set(family, (map.get(family) || 0) + (value || 0));
  }
  return [...map.entries()]
    .filter(([family, value]) => REPORT_FAMILIES.includes(family) || value)
    .map(([family, value]) => ({ family, value: Math.round(value) }));
}

// Cocinas: las categorias (Vacuno, Pollo, Pan...) no calzan con las familias
// de bebidas y todo caia en "Otros". Cuando "Otros" domina, se agrupa por las
// categorias reales del reporte (top 7 por impacto).
// Excluye totales "padre" (ej. "Total Whisky" que agrupa Scotch/Irish/Bourbon):
// un total cuyo valor coincide con la suma de los totales anteriores contiguos
// duplicaria el monto de la familia.
function dropParentTotals(entries) {
  const kept = [...entries];
  const tolerance = (value) => Math.max(2, Math.abs(value) * 0.002);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < kept.length && !changed; i += 1) {
      const value = kept[i].value || 0;
      if (!value) continue;
      // padre despues de los hijos (Total Whisky tras Scotch/Irish/Bourbon)
      let accumulated = 0;
      for (let back = i - 1; back >= 0 && i - back <= 12; back -= 1) {
        accumulated += kept[back].value || 0;
        if (Math.abs(accumulated - value) <= tolerance(value)) {
          kept.splice(i, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
      // padre antes de los hijos (encabezado de grupo con el total ya cargado)
      accumulated = 0;
      for (let forward = i + 1; forward < kept.length && forward - i <= 12; forward += 1) {
        accumulated += kept[forward].value || 0;
        if (Math.abs(accumulated - value) <= tolerance(value)) {
          kept.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
  }
  return kept;
}

function aggregateReportGroups(rawEntries, { dropParents = true } = {}) {
  // dropParents solo tiene sentido cuando las entradas vienen de filas de
  // TOTALES (donde un total "padre" duplicaria a sus hijos). Con entradas de
  // productos individuales borraba por error cualquier producto cuyo monto
  // coincidiera con la suma de los anteriores, descuadrando las familias.
  const entries = dropParents ? dropParentTotals(rawEntries) : rawEntries;
  const familyRows = aggregateByFamily(entries);
  const totalAbs = entries.reduce((sum, item) => sum + Math.abs(item.value || 0), 0);
  const otherAbs = Math.abs(familyRows.find((row) => row.family === "Otros")?.value || 0);

  if (!totalAbs || otherAbs / totalAbs <= 0.5) return familyRows;

  const byCategory = new Map();
  for (const { category, value } of entries) {
    const key = cleanTotalName(category || "") || "Sin categoría";
    byCategory.set(key, (byCategory.get(key) || 0) + (value || 0));
  }
  return [...byCategory.entries()]
    .map(([family, value]) => ({ family, value: Math.round(value) }))
    .filter((row) => row.value)
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
    .slice(0, 7);
}

// Variaciones (ahorro/faltante) agregadas por familia, para el grafico de
// barras divergentes del PDF.
function buildFamilyVariances(varianceRows) {
  const entries = varianceRows
    .filter((row) => isTotalRow(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]))
    .map((row) => ({
      category: cleanTotalName(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]),
      value: parseNumber(row["Diferencia (Costo)"]),
    }));
  return aggregateReportGroups(entries).map(({ family, value }) => ({ family, amount: value }));
}

// Compra realizada ($) por familia, desde los totales del variance.
function buildFamilyPurchases(varianceRows) {
  const entries = varianceRows
    .filter((row) => isTotalRow(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]))
    .map((row) => ({
      category: cleanTotalName(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]),
      value: parseNumber(row["Compras (Costo)"]),
    }));
  return aggregateReportGroups(entries).map(({ family, value }) => ({ family, purchased: value }));
}

// Compra sugerida ($) por familia, desde los totales de Intelipar (Costo Pedido).
function buildFamilySuggested(inteliparRows) {
  const entries = inteliparRows
    .filter((row) => isTotalRow(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]))
    .map((row) => ({
      category: cleanTotalName(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]),
      value: parseNumber(row["Costo Pedido"]),
    }));
  return aggregateReportGroups(entries).map(({ family, value }) => ({ family, suggested: value }));
}

// Top 10 productos por uso ($) para la tabla "Desempeño de los 10 productos
// con mayor uso" del PDF.
function buildTopUsageProducts(varianceRows) {
  return varianceRows
    .filter((row) => !isTotalRow(row["Nombre Artículo"] || row["Nombre ArtÃ­culo"]))
    .map((row) => ({
      name: row["Nombre Artículo"] || row["Nombre ArtÃ­culo"] || "",
      usedCost: parseNumber(row["Usado (Costo)"]),
      varianceAmount: parseNumber(row["Diferencia (Costo)"]),
      variancePercent: parseNumber(row["% Diferencia"]),
      realCostPercent: parseNumber(row["Porcentaje de Costo"]),
    }))
    .filter((row) => row.name && row.usedCost)
    .sort((left, right) => right.usedCost - left.usedCost)
    .slice(0, 10);
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
  let category = "Sin categoría";

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
        stock: cleanCellValue(row["Existencia"]),
        suggested: cleanCellValue(order),
        note: excess
          ? `Exceso ${excess}${daysRemaining ? `, ${daysRemaining} días restantes` : ""}`
          : "Validar proveedor y sugerencia antes del envío",
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
  const wasteCost = productRows.reduce((total, row) => total + parseNumber(row["Desperdicio (Costo)"]), 0);
  const inventoryCost = productRows.reduce((total, row) => total + parseNumber(row["Existencia (Costo)"]), 0);
  const purchasedCost = productRows.reduce((total, row) => total + parseNumber(row["Compras (Costo)"]), 0);

  return {
    revenue,
    usedCost,
    soldCost,
    wasteCost,
    inventoryCost,
    purchasedCost,
    costPercent: revenue ? Number(((usedCost / revenue) * 100).toFixed(1)) : 0,
    idealCostPercent: revenue ? Number(((soldCost / revenue) * 100).toFixed(1)) : 0,
    variancePercent: soldCost ? Number(((varianceAmount / soldCost) * 100).toFixed(1)) : 0,
    varianceAmount,
  };
}

function commentsForReport(clientName, report) {
  const direction = report.summary.varianceAmount < 0 ? "faltantes" : "sobrantes";
  const biggestCategory = report.categoryVariances[0]?.category || "las categorías principales";

  return `${clientName} presenta un costo de ${report.summary.costPercent}% para el periodo, con una diferencia acumulada de ${moneyPlain(report.summary.varianceAmount)} asociada principalmente a ${biggestCategory}. Revisar los productos con mayor variación y validar la sugerencia de compra antes del envío al cliente, especialmente proveedores marcados como por validar.`;
}

// Limpia restos de comillas u otros artefactos de celdas CSV/HTML.
function cleanCellValue(value) {
  return String(value || "").replace(/["“”]/g, "").trim();
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
    : "sin categorías con variación relevante";
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
    `El periodo registra ingresos por ${moneyPlain(summary.revenue)} y un costo de ${summary.costPercent || 0}%. La diferencia acumulada es ${moneyPlain(summary.varianceAmount)} (${summary.variancePercent || 0}%), asociada principalmente a ${varianceTone} o diferencias operativas que deben revisarse antes del envío.`,
    "",
    `Categorías con mayor impacto: ${categoryText}.`,
    "",
    `Productos a revisar: ${productText}.`,
    "",
    `Sugerencia de compra Intelipar: ${purchaseText}. ${providerText}`,
    "",
    "Recomendacion: revisar los productos con mayor variacion, confirmar proveedores sugeridos y validar si las diferencias corresponden a merma, registro de venta, compra no actualizada o ajuste operativo.",
  ].join("\n");
}

const criteriaCategoryLabels = {
  project_instructions: "Instrucciones del proyecto",
  report_prompt: "Prompt de reporte",
  analysis_rules: "Reglas de análisis",
  purchase_rules: "Reglas de compra",
  comment_examples: "Ejemplos de comentarios",
  operations_questionnaire: "Cuestionario de operaciones",
  project_file: "Documento del proyecto",
};

// Resumen legible de un criterio para mostrar en "Criterios aplicados" (modo
// plantilla): nombre, tipo y las secciones que cubre, sin volcar el texto crudo.
function summarizeCriteriaForDisplay(document) {
  const label = criteriaCategoryLabels[document.category] || "Criterio";
  const headings = String(document.text || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.*)$/)?.[1]?.trim())
    .filter(Boolean)
    .filter((heading) => !/^radici|^#/i.test(heading))
    .slice(0, 5);

  if (headings.length) {
    return `${document.name} (${label}): cubre ${headings.join(", ")}. Se aplicará al generar el reporte con IA.`;
  }
  const excerpt = String(document.text || "").replace(/\s+/g, " ").trim().slice(0, 140);
  return `${document.name} (${label}): ${excerpt || "criterio disponible para el reporte."}`;
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
  const criteriaApplied = criteriaForClient(payload.criteriaDocuments || [], payload.client?.name, payload.client?.id || payload.clientId || "", payload.allClientNames || [])
    .slice(0, 4)
    .map((document) => summarizeCriteriaForDisplay(document));

  return {
    bestOfWeek: bestProducts.map(
      (item) =>
        `En ${item.name} (${item.category}) se observa un ahorro o diferencia positiva de ${money.format(item.varianceAmount)} (${item.variancePercent}%), aportando al resultado semanal.`,
    ),
    weeklyChallenges: [
      ...challengeCategories.map(
        (item) =>
          `En la categoría ${item.category} se concentra una diferencia negativa de ${money.format(item.amount)} (${item.percent}%), por lo que conviene revisar inventario, merma y registro de ventas.`,
      ),
      ...challengeProducts.map(
        (item) =>
          `${item.name} presenta una diferencia de ${money.format(item.varianceAmount)} (${item.variancePercent}%) dentro de ${item.category}; revisar conteo, consumo y posibles ajustes operativos.`,
      ),
    ].slice(0, 5),
    stockEfficiency: purchaseItems.map(
      (item) =>
        `${item.item}: stock ${cleanCellValue(item.stock) || "s/i"}, compra sugerida ${cleanCellValue(item.suggested) || "por revisar"}, proveedor ${item.provider || "por validar"}. ${cleanCellValue(item.note) || ""}`.trim(),
    ),
    criteriaApplied,
    agentNotes: (payload.comments || "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .slice(0, 5),
  };
}

// Selecciona los criterios de la biblioteca que corresponden al cliente del
// reporte. Prioriza los documentos que mencionan al cliente; si no hay match,
// usa los criterios generales.
// Criterios estilo "skills": cada documento puede asignarse a un cliente y se
// activa solo al generar SU reporte. Prioridad: asignados al cliente >
// generales que lo mencionan > generales. Los asignados a OTRO cliente nunca
// se filtran hacia reportes ajenos.
// Selecciona el conocimiento que aplica a un reporte. Orden de prioridad:
// 1) memoria aprendida del chat, 2) skills asignadas al cliente, 3) generales
// que NOMBRAN a este cliente, 4) generales "de casa". Un general cuyo NOMBRE
// corresponde a otro cliente se excluye: antes se filtraba a todos los
// clientes sin skill y contaminaba sus analisis con reglas ajenas.
function criteriaForClient(criteriaDocuments = [], clientName = "", clientId = "", allClientNames = []) {
  // Comparaciones sin tildes: "Café Diario" (cliente) vs "Cafe Diario" (doc).
  const normalize = (value) => String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const clientKey = normalize(clientName);
  const accountKey = clientKey.split(" - ")[0].trim();
  const otherClientKeys = (allClientNames || [])
    .map((name) => normalize(name).split(" - ")[0].trim())
    .filter((key) => key && key.length > 3 && key !== accountKey && !accountKey.startsWith(key) && !key.startsWith(accountKey));

  const assigned = clientId
    ? criteriaDocuments.filter((document) => document.clientId === clientId)
    : [];
  const general = criteriaDocuments.filter((document) => !document.clientId);
  const matched = clientKey
    ? general.filter((document) => {
        const haystack = normalize(`${document.name} ${document.category} ${document.text}`);
        return haystack.includes(clientKey) || (accountKey && haystack.includes(accountKey));
      })
    : [];
  const shared = general.filter((document) => {
    const nameKey = normalize(document.name);
    // Los documentos con formato de skill ("X — Criterios de analisis") son de
    // un cliente concreto aunque esten sin asignar (ej. clientes sin unidad en
    // Sculpture): solo aplican por asignacion o porque nombran a este cliente.
    if (/criterios de analisis/.test(nameKey) && !matched.includes(document)) return false;
    return !otherClientKeys.some((key) => nameKey.includes(key));
  });

  const ordered = [];
  const seen = new Set();
  for (const document of [...assigned, ...matched, ...shared]) {
    if (!document || seen.has(document.id)) continue;
    seen.add(document.id);
    ordered.push(document);
  }
  const learning = ordered.filter((document) => document.name === "Aprendizajes del chat");
  const rest = ordered.filter((document) => document.name !== "Aprendizajes del chat");
  return [...learning, ...rest].slice(0, 6);
}

// Metodologia estandar de analisis Bevinco (prompt maestro compartido por el
// equipo). Se aplica a todos los reportes; los criterios por cliente la refinan.
const BEVINCO_ANALYSIS_METHOD = `
Eres el analista de auditoria de Bevinco. Analizas reportes semanales de Sculpture Hospitality (variance detailed y summary) y redactas comentarios ejecutivos para el cliente.

REGLAS BASE
- El reporte (variance) es la fuente principal y prioritaria. Los comentarios de operaciones (OPS) son solo contexto y se usan unicamente si ayudan a explicar una desviacion relevante; no fuerces explicaciones sin sustento en los datos.
- Prioriza siempre el impacto economico real. No comentes ruido ni desviaciones insignificantes.
- Clasifica cada producto antes de redactar como: positivo, desafio o ruido. Un mismo producto NO puede aparecer en "Lo mejor" y en "Los desafios".
- Estructura el analisis priorizando las CATEGORIAS/familias sobre el detalle por producto: identifica primero las categorias con mayor desviacion y comenta a ese nivel. Usa el producto que explica la mayor parte de la desviacion como evidencia dentro del comentario de su categoria, no como comentario suelto.

FORMATO DE DESVIACIONES
- Toda desviacion relevante se muestra asi: En [producto] (kgs o unidades / % / $). Ejemplo: "En merluza (-3,5 kgs / 22% / $31.500)". Usa solo los datos disponibles, sin inventar. Formatea montos en pesos chilenos (CLP).

REGLAS DE INTERPRETACION
- Si el rendimiento coincide con el registrado en sistema y aun asi hay diferencia: interpretar como posible servicio/porcionado y sugerir revisar porciones.
- Si un ahorro se explica por despuntes, insumos no auditados, prestamos o reasignaciones: es resultado no estructural, no lo presentes como mejora real de gestion.
- Si una desviacion es extrema (>50%): interpretala primero como problema de registro (factura faltante, error de conteo o desfase de ingreso), no como operacion salvo evidencia clara.
- Si no hay explicacion clara: escribe "sin explicacion" o "se sugiere conversar internamente para revisar la causa".
- Evita frases vagas ("control incompleto", "podria haber error", "hay que revisar") salvo que precises exactamente que revisar y por que importa.
- Si una desviacion compensa una opuesta de la semana anterior: interpretala como posible ajuste intersemanal o error de conteo, no como mejora real.

PRIORIZACION: ordena hallazgos por 1) impacto en $, 2) impacto en margen, 3) relevancia operativa, 4) recurrencia historica.

ANALISIS ESTRATEGICO (OBLIGATORIO)
- Parte SIEMPRE por los 2-3 hallazgos de mayor impacto economico del periodo y di que significan para el negocio; el resto solo si aporta.
- Los criterios y ejemplos del cliente son la PLANTILLA OBLIGATORIA: replica su estructura, terminologia y estilo de redaccion. No inventes un formato propio.
- PROHIBIDO: comentar desviaciones de bajo impacto, listar cifras sin interpretacion, repetir el resumen sin agregar analisis, y mencionar detalles tecnicos del sistema (fuentes, sincronizacion, nombres de columnas o reportes internos).

FORMATO DE ENTREGA
- DIAGNOSTICO (interno): 3 a 5 bullets breves y tecnicos.
- LO MEJOR DE LA SEMANA: maximo 2-3 puntos, solo hallazgos positivos atribuibles a buena gestion (no resultados por error de registro o compensaciones). Directo, sin titulo por punto.
- LOS DESAFIOS DE LA SEMANA: maximo 3-5 puntos, enfoca en el producto que explica la desviacion, explica causa si aplica, incluye impacto en formato kgs/%/$ y recomendacion solo si agrega valor.
- EFICIENCIA DE STOCK Y COMPRA: evalua cobertura (dias), coherencia compra vs consumo, sobrestock o riesgo de quiebre. No fuerces comentario si no hay hallazgos; si esta alineado, dilo breve.

TONO Y ESTILO: tecnico, claro, consultivo, no acusatorio, breve y directo. Usa "se observa", "se detecta", "podria estar asociado", "se sugiere revisar/conversar internamente". Sin emojis, sin subtitulos dentro de cada bullet, sin repetir ideas, con la menor cantidad de palabras posible sin perder claridad.
`.trim();

// Genera el analisis ejecutivo con OpenAI usando los criterios del cliente.
// Devuelve null ante cualquier problema para que el flujo caiga en la plantilla.
async function generateReportAnalysisAI(payload) {
  if (!openaiApiKey) { console.error("[openai] sin OPENAI_API_KEY configurada"); return null; }

  const summary = payload.summary || {};
  const clientName = payload.client?.name || payload.clientId;
  const periodLabel = payload.period?.label || payload.periodId;
  const isMonthly = Boolean(payload.monthly || payload.isAccumulated);
  // Presupuesto de caracteres para los criterios del cliente. Se usa el documento
  // (casi) completo para no perder reglas ni ejemplos, con un tope total que
  // controla el costo por reporte.
  const CRITERIA_PER_DOC = 8000;
  const CRITERIA_TOTAL_BUDGET = 20000;
  let criteriaBudget = CRITERIA_TOTAL_BUDGET;
  const criteria = criteriaForClient(payload.criteriaDocuments || [], clientName, payload.client?.id || payload.clientId || "", payload.allClientNames || [])
    .map((document) => {
      if (criteriaBudget <= 0) return null;
      const contenido = String(document.text || "").trim().slice(0, Math.min(CRITERIA_PER_DOC, criteriaBudget));
      criteriaBudget -= contenido.length;
      return { nombre: document.name, categoria: document.category, contenido };
    })
    .filter(Boolean);

  const reportData = {
    cliente: clientName,
    periodo: periodLabel,
    tipo: isMonthly ? "mensual (acumulado de las semanas incluidas)" : "semanal",
    semanasIncluidas: isMonthly ? (payload.includedPeriods || []).map((item) => item.label) : undefined,
    eficienciaStock: isMonthly && payload.stockEfficiency
      ? {
          sinRotacion: (payload.stockEfficiency.slowMovers || []).slice(0, 10),
          coberturaPorCategoria: (payload.stockEfficiency.categoryCoverage || []).slice(0, 12),
        }
      : undefined,
    resumen: {
      ingresos: summary.revenue || 0,
      costoPorcentaje: summary.costPercent || 0,
      variancePorcentaje: summary.variancePercent || 0,
      varianceMonto: summary.varianceAmount || 0,
    },
    categorias: (payload.categoryVariances || []).slice(0, 10),
    productos: (payload.topProducts || []).slice(0, 10),
    sugerenciasCompra: (payload.purchaseSuggestions || []).slice(0, 12),
    historico: (payload.history || []).slice(0, 6),
  };

  const monthlyNote = isMonthly ? `
INSTRUCCIONES PARA REPORTE MENSUAL
- Este reporte es un ACUMULADO MENSUAL: ingresos, costos y variance son la SUMA de las semanas incluidas; el stock/existencias es la foto de la ultima semana.
- Analiza el mes como un todo usando los totales del periodo completo; no comentes una semana suelta como si fuera el reporte entero.
- Usa el historico (las semanas incluidas) para describir la tendencia dentro del mes: que semanas explican el resultado y si hay mejora o deterioro sostenido.
- Redacta los hallazgos como "lo mejor del mes" y "los desafios del mes" (manten las mismas claves JSON bestOfWeek/weeklyChallenges).
- En eficiencia de stock y compra evalua el comportamiento del mes completo (compra vs consumo acumulado, tendencia de cobertura), no la foto de la ultima semana.
` : "";

  const prompt = `
${BEVINCO_ANALYSIS_METHOD}
${monthlyNote}
Aplica ESTRICTAMENTE los criterios especificos del cliente cuando existan (tienen prioridad sobre las reglas generales si hay conflicto). No inventes datos: usa solo las cifras entregadas.

Si los criterios del cliente incluyen EJEMPLOS de comentarios o reportes anteriores, imita fielmente ese estilo, estructura y redaccion (no copies los productos ni las cifras del ejemplo: usa solo los datos del reporte actual).

Devuelve SOLO JSON valido con esta forma:
{
  "comments": "resumen ejecutivo en 1-3 parrafos para el cuerpo del reporte",
  "emailDraft": "resumen ejecutivo BREVE para el cuerpo del correo (maximo ~120 palabras): saludo, diagnostico principal del periodo, % de costo, variance en $ y %, 2-3 puntos clave, y cierre que indique que el detalle completo va adjunto en PDF",
  "analysis": {
    "bestOfWeek": ["frases de lo mejor de la semana, formato 'En [producto] (.../%/$)...'"],
    "weeklyChallenges": ["frases de desafios, enfocadas en el producto que explica la desviacion, con impacto kgs/%/$"],
    "stockEfficiency": ["frases sobre cobertura en días, compra vs consumo y sobrestock/quiebre"],
    "criteriaApplied": ["que criterio del cliente se aplico y como"],
    "agentNotes": ["DIAGNOSTICO interno: 3-5 bullets breves y tecnicos"]
  }
}

Respeta los maximos por seccion (Lo mejor 2-3, Desafios 3-5). Si falta informacion para una seccion, incluye una frase indicando el pendiente.

Criterios especificos del cliente:
${criteria.length ? JSON.stringify(criteria, null, 2) : "Sin criterios especificos cargados para este cliente; aplica la metodologia estandar Bevinco de arriba."}

Datos del reporte:
${JSON.stringify(reportData, null, 2)}
`.trim();

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: openaiModel,
        input: prompt,
        max_output_tokens: 4000,
      }),
    });

    const responsePayload = await openaiResponse.json().catch(() => ({}));
    if (!openaiResponse.ok) {
      console.error("OpenAI analysis error:", responsePayload?.error?.message || openaiResponse.status);
      return null;
    }

    const rawText = extractOpenAiText(responsePayload);
    const parsed = extractJsonPayload(rawText);
    if (!parsed?.analysis) {
      console.error("[openai] respuesta sin analysis parseable. status:", responsePayload?.status, "| texto (300):", String(rawText).slice(0, 300));
      return null;
    }

    const toList = (value) =>
      Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 5) : [];

    return {
      comments: String(parsed.comments || "").trim(),
      emailDraft: String(parsed.emailDraft || "").trim(),
      analysis: {
        bestOfWeek: toList(parsed.analysis.bestOfWeek),
        weeklyChallenges: toList(parsed.analysis.weeklyChallenges),
        stockEfficiency: toList(parsed.analysis.stockEfficiency),
        criteriaApplied: toList(parsed.analysis.criteriaApplied),
        agentNotes: toList(parsed.analysis.agentNotes),
      },
    };
  } catch (aiError) {
    console.error("OpenAI analysis exception:", aiError?.message || aiError);
    return null;
  }
}

function extractJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // Continue to object extraction.
      }
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function extractOpenAiText(payload) {
  if (payload?.output_text) return payload.output_text;
  const chunks = [];
  for (const output of payload?.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === "string" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function generateChatGptCriteriaDocuments({ projectName, sections, files }) {
  if (!openaiApiKey) {
    const error = new Error("OPENAI_API_KEY no esta configurada en el servidor.");
    error.status = 503;
    throw error;
  }

  const sectionText = Object.entries(sections || {})
    .filter(([, value]) => String(value || "").trim())
    .map(([key, value]) => `## ${key}\n${String(value).trim()}`)
    .join("\n\n");
  const fileText = (files || [])
    .filter((file) => String(file.text || "").trim())
    .map((file) => `## Archivo: ${file.name}\n${String(file.text).trim().slice(0, 12000)}`)
    .join("\n\n");
  const combined = [sectionText, fileText].filter(Boolean).join("\n\n---\n\n").slice(0, 60000);

  if (!combined.trim()) {
    const error = new Error("No hay contenido para procesar con OpenAI.");
    error.status = 400;
    throw error;
  }

  const prompt = `
Convierte el siguiente contenido de un Project de ChatGPT usado por Bevinco en documentos de criterio para un CMS de reportes.

Objetivo del CMS:
- Generar reportes semanales de auditoria Bevinco/Sculpture Hospitality.
- Explicar costo real vs costo ideal, diferencias en puntos porcentuales y diferencia en pesos.
- Comentar aumentos o disminuciones relevantes contra semanas anteriores.
- Comparar compra real contra sugerencia de compra de la semana anterior.
- Detectar top 3 desviaciones y criterios de operaciones.

Devuelve SOLO JSON valido con esta forma:
{
  "summary": "resumen corto de lo importado",
  "documents": [
    {
      "name": "nombre claro del documento",
      "category": "project_instructions|report_prompt|analysis_rules|purchase_rules|comment_examples|operations_questionnaire|project_file",
      "text": "contenido depurado en markdown, sin inventar informacion"
    }
  ]
}

Reglas:
- No inventes datos. Si algo falta, incluyelo como pendiente dentro del documento adecuado.
- Separa reglas repetidas y consolida duplicados.
- Escribe en espanol claro para operaciones.
- Maximo 8 documentos.
- Cada text debe servir directamente como criterio que el agente pueda consultar.

Proyecto: ${projectName || "Proyecto ChatGPT Bevinco"}

Contenido:
${combined}
`.trim();

  const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openaiApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: openaiModel,
      input: prompt,
      max_output_tokens: 5000,
    }),
  });

  const payload = await openaiResponse.json().catch(() => ({}));

  if (!openaiResponse.ok) {
    const error = new Error(payload?.error?.message || "OpenAI no pudo procesar los criterios.");
    error.status = openaiResponse.status;
    throw error;
  }

  const parsed = extractJsonPayload(extractOpenAiText(payload));
  const documents = Array.isArray(parsed?.documents) ? parsed.documents : [];

  if (!documents.length) {
    const error = new Error("OpenAI no devolvio documentos validos para guardar en biblioteca.");
    error.status = 502;
    throw error;
  }

  return {
    summary: String(parsed.summary || "Contenido procesado con OpenAI."),
    documents: documents
      .map((document, index) => ({
        name: String(document.name || `Criterio ChatGPT ${index + 1}`).trim(),
        category: String(document.category || "project_file").trim(),
        text: String(document.text || "").replace(/\0/g, "").trim(),
      }))
      .filter((document) => document.text)
      .slice(0, 8),
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
        familyVariances: buildFamilyVariances(varianceRows),
        familyPurchases: buildFamilyPurchases(varianceRows),
        topUsageProducts: buildTopUsageProducts(varianceRows),
        purchaseSuggestions: buildPurchaseSuggestions(inteliparRows),
        familySuggested: buildFamilySuggested(inteliparRows),
        analysis: null,
        comments: "",
        emailDraft:
          "Hola, adjuntamos el reporte semanal de auditoría. En el resumen se destacan las principales variaciones, productos a revisar y sugerencias de compra para el siguiente periodo.",
        sourceStatus: {
          varianceDetailed: "Datos cargados",
          varianceSummary: "Por revisar",
          intelipar: "Datos cargados",
        },
      };
      report.summary.suggestedCost = report.familySuggested.reduce((total, item) => total + (item.suggested || 0), 0);
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

// Respaldo cuando el nombre exacto de la columna cambia entre locales de
// Sculpture (ej. "Orden", "Pedido sugerido", "Cantidad sugerida"): busca la
// primera columna con dato cuyo nombre matchee el patron, saltando las que
// matcheen la exclusion (para no confundir cantidad con costo o dias).
function pickRecordValueFuzzy(record, pattern, exclude = null) {
  for (const [key, value] of Object.entries(record || {})) {
    if (value === undefined || value === "") continue;
    if (!pattern.test(key)) continue;
    if (exclude && exclude.test(key)) continue;
    return value;
  }
  return "";
}

function extractReportMetrics(parsedTable) {
  const rows = parsedTable.rows || [];
  const categoryMap = new Map();
  const categoryPercentMap = new Map();
  const products = [];
  const pendingProducts = [];
  let currentCategory = "";
  let revenue = 0;
  let usedCost = 0;
  let soldCost = 0;
  let varianceTotal = 0;
  let wasteCost = 0;
  let inventoryCost = 0;
  let purchasedCost = 0;
  let grandSummary = null;

  rows.forEach((row) => {
    const values = row.values || [];
    const itemName = pickRecordValue(row.record, ["itemName", "item", "product", "productName", "producto", "nombreArticulo", "nombreArtículo", "nombreArtCulo"], values[0] || "");
    const isGrandTotal = /grand\s+total/i.test(itemName);
    const isCategoryRow = isTotalRow(itemName) || /^total\s+/i.test(itemName) || /:\s*$/.test(itemName);
    const category = isCategoryRow ? cleanTotalName(itemName) : "";
    const varianceValue = pickRecordValue(row.record, [
      "variance",
      "varianceAmount",
      "difference",
      "extendedDifference",
      "diferenciaCosto",
      "ahorroFaltanteCosto",
      "faltanteCosto",
    ]) || "0";
    const amount = parseNumber(varianceValue);
    const percentValue =
      pickRecordValue(row.record, ["variancePercent", "differencePercent", "diferencia", "diferenciaPct", "porcentajeDiferencia"]) ||
      values.find((value) => String(value).includes("%"));
    const rowRevenue = parseNumber(pickRecordValue(row.record, ["revenue", "ingresos", "sales", "ventas"]));
    const rowUsedCost = parseNumber(pickRecordValue(row.record, ["usedCost", "usadoCosto", "costoUsado", "usageCost"]));
    const rowSoldCost = parseNumber(pickRecordValue(row.record, ["soldCost", "vendidoCosto", "costoVendido", "salesCost"]));
    const rowCostPercent = parseNumber(pickRecordValue(row.record, ["costPercent", "porcentajeDeCosto", "porcentajeCosto", "costoDeAlimentos", "pourCost"]));
    const rowWasteCost = parseNumber(pickRecordValue(row.record, ["wasteCost", "desperdicioCosto", "mermaCosto"]));
    const rowInventoryCost = parseNumber(pickRecordValue(row.record, ["inventoryCost", "existenciaCosto", "stockCosto"]));
    const rowPurchasedCost = parseNumber(pickRecordValue(row.record, ["purchasedCost", "comprasCosto", "compraCosto"]));
    const rowHasNumbers = Boolean(rowRevenue || rowUsedCost || rowSoldCost || amount || rowInventoryCost || rowPurchasedCost);

    if (isGrandTotal) {
      grandSummary = {
        revenue: rowRevenue,
        costPercent: rowCostPercent,
        idealCostPercent: parseNumber(pickRecordValue(row.record, ["idealCostPercent", "porcentajeDeCostoIdeal", "porcentajeCostoIdeal", "costoDeAlimentosIdeal", "pourCostIdeal"])),
        variancePercent: parseNumber(percentValue),
        varianceAmount: amount,
      };
      return;
    }

    if (isCategoryRow) {
      if (!rowHasNumbers) {
        // Encabezado de subcategoria (ej. cocina: "Pollo:" antes de sus
        // productos): define la categoria de las filas que siguen.
        currentCategory = category;
      } else {
        // Total de cierre (ej. "Total Pollo:"): asigna la categoria a los
        // productos que quedaron pendientes (bebidas: productos primero,
        // total despues) y registra el total para la lista de categorias.
        pendingProducts.forEach((product) => {
          if (!product.category) product.category = category;
        });
        pendingProducts.length = 0;
        categoryMap.set(category, amount);
        categoryPercentMap.set(category, parseNumber(percentValue));
        currentCategory = "";
      }
      return;
    }

    revenue += rowRevenue;
    usedCost += rowUsedCost;
    soldCost += rowSoldCost;
    varianceTotal += amount;
    wasteCost += rowWasteCost;
    inventoryCost += rowInventoryCost;
    purchasedCost += rowPurchasedCost;

    if (itemName) {
      const product = {
        name: itemName,
        category: currentCategory || "",
        varianceAmount: amount,
        variancePercent: parseNumber(percentValue),
        usedCost: rowUsedCost,
        realCostPercent: rowCostPercent,
        purchasedCost: rowPurchasedCost,
      };
      products.push(product);
      if (!product.category) pendingProducts.push(product);
    }
  });

  const categoryVariances = Array.from(categoryMap.entries()).map(([category, amount]) => ({
    category,
    amount,
    percent: categoryPercentMap.get(category) || 0,
  }));

  // Familias agregadas desde los PRODUCTOS (no desde los totales): los
  // totales incluyen filas "padre" anidadas que duplicaban montos, y desde
  // productos la suma cuadra exacta con el variance total.
  const productEntries = products
    .filter((product) => product.varianceAmount)
    .map((product) => ({ category: product.category || "Sin categoría", value: product.varianceAmount }));
  const purchaseEntries = products
    .filter((product) => product.purchasedCost)
    .map((product) => ({ category: product.category || "Sin categoría", value: product.purchasedCost }));

  const extras = {
    usedCost,
    soldCost,
    wasteCost,
    inventoryCost,
    purchasedCost,
    idealCostPercent: revenue ? Number(((soldCost / revenue) * 100).toFixed(1)) : 0,
  };

  return {
    summary: grandSummary
      ? { ...extras, ...grandSummary, idealCostPercent: grandSummary.idealCostPercent || extras.idealCostPercent }
      : {
          revenue,
          ...extras,
          costPercent: revenue ? Number(((usedCost / revenue) * 100).toFixed(1)) : 0,
          variancePercent: soldCost ? Number(((varianceTotal / soldCost) * 100).toFixed(1)) : 0,
          varianceAmount: varianceTotal,
        },
    categoryVariances: categoryVariances.slice(0, 8),
    familyVariances: aggregateReportGroups(productEntries, { dropParents: false }).map(({ family, value }) => ({ family, amount: value })),
    familyPurchases: aggregateReportGroups(purchaseEntries, { dropParents: false }).map(({ family, value }) => ({ family, purchased: value })),
    topUsageProducts: products
      .filter((product) => product.usedCost > 0)
      .sort((left, right) => right.usedCost - left.usedCost)
      .slice(0, 10),
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
    report.summary = { ...(report.summary || {}), ...buildSummary(rows) };
    report.categoryVariances = buildCategoryVariances(rows);
    report.topProducts = buildTopProducts(rows);
    report.familyVariances = buildFamilyVariances(rows);
    report.familyPurchases = buildFamilyPurchases(rows);
    report.topUsageProducts = buildTopUsageProducts(rows);
  }

  if (sourceType === "intelipar") {
    report.purchaseSuggestions = buildPurchaseSuggestions(rows);
    report.familySuggested = buildFamilySuggested(rows);
    report.summary = report.summary || {};
    report.summary.suggestedCost = report.familySuggested.reduce((total, item) => total + (item.suggested || 0), 0);
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
    // Colores reales de los tags de ClickUp, para pintar las tarjetas del CMS.
    tagDetails: (task.tags || [])
      .map((tag) => ({ name: tag.name || "", bg: tag.tag_bg || "", fg: tag.tag_fg || "" }))
      .filter((tag) => tag.name),
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

// Sugerencia de compra para cocina, replicando el Excel del equipo
// ("Tambo - Analisis de compra + Sugerencia de compra cocina"):
//   PAR             = techo(consumo diario x (dias de sugerencia + dias extra) x (1 + % cobertura))
//   Compra sugerida = techo(max(PAR - existencia, 0))
//   Inventario dias = redondeo(existencia / consumo x dias del periodo)
//   Exceso $        = si el inventario supera 2.5x los dias de sugerencia,
//                     los dias sobrantes x consumo diario x costo unitario.
// Sculpture solo calcula Par/Orden/Costo Pedido para Beverage; las tablas de
// cocina (Food) traen los insumos crudos y aca se completan esas columnas,
// para que el resto del flujo (sugerencias, familias, resumen) funcione igual.
// Stock por articulo segun el variance DETAILED. En cocina es la fuente
// correcta de inventario: incluye los productos procesados por el local
// ("PREP POLLO", porciones recongeladas), que el Intelipar ignora porque el
// sistema gringo asume que lo descongelado no se reutiliza. Metodo del
// equipo: PAR del Intelipar + inventario del detailed.
function buildDetailedStockMap(rows) {
  const stock = new Map();
  for (const row of rows || []) {
    const record = row.record || {};
    const name = String(
      pickRecordValue(record, ["itemName", "item"], "") ||
      pickRecordValueFuzzy(record, /nombreArt/i) ||
      row.values?.[0] || "",
    ).trim();
    if (!name || isTotalRow(name) || /:\s*$/.test(name)) continue;
    const units = parseNumber(record.existencia);
    if (units) stock.set(name.toLowerCase(), units);
  }
  return stock;
}

// Inventario efectivo de un producto comprable: su stock segun el detailed
// (si aparece) mas el stock de sus formas procesadas convertido a equivalente
// de materia prima (stock limpio / rendimiento). Los mapeos crudo<->procesado
// se configuran por cliente en client.stateMappings:
//   [{ comprable: "Pechuga Deshuesada", procesados: [{ nombre: "PREP POLLO", rendimiento: 0.8 }] }]
function applyEffectiveInventory(rows, detailedStock, client) {
  if (!detailedStock?.size) return;
  const mappings = Array.isArray(client?.stateMappings) ? client.stateMappings : [];
  for (const row of rows || []) {
    const record = row.record || {};
    const name = String(
      pickRecordValue(record, ["itemName", "item"], "") ||
      pickRecordValueFuzzy(record, /nombreArt/i) ||
      row.values?.[0] || "",
    ).trim();
    if (!name || isTotalRow(name) || /:\s*$/.test(name)) continue;
    const key = name.toLowerCase();
    let stock = detailedStock.has(key) ? detailedStock.get(key) : parseNumber(record.existencia);
    const mapping = mappings.find((item) => String(item.comprable || "").toLowerCase() === key);
    for (const processed of mapping?.procesados || []) {
      const processedStock = detailedStock.get(String(processed.nombre || processed.name || "").toLowerCase());
      if (!processedStock) continue;
      const yieldFactor = Number(processed.rendimiento ?? processed.factor);
      stock += yieldFactor > 0 && yieldFactor <= 1 ? processedStock / yieldFactor : processedStock;
    }
    if (Number.isFinite(stock)) record.existencia = String(Number(stock.toFixed(2)));
  }
}

// Eficiencia de stock desde el variance detailed: productos con inventario y
// sin rotacion en el periodo, y dias de cobertura por categoria (para la
// seccion de stock del reporte mensual, reunion 17-jul).
function buildStockEfficiency(rows, daysInPeriod = 7) {
  const slowMovers = [];
  const categories = [];
  for (const row of rows || []) {
    const record = row.record || {};
    const name = String(
      pickRecordValue(record, ["itemName", "item"], "") ||
      pickRecordValueFuzzy(record, /nombreArt/i) ||
      row.values?.[0] || "",
    ).trim();
    if (!name) continue;
    const stockCost = parseNumber(record.existenciaCosto);
    const usedCost = parseNumber(record.usadoCosto);
    const usedUnits = parseNumber(record.usado);
    if (isTotalRow(name)) {
      if (stockCost || usedCost) {
        categories.push({
          category: cleanTotalName(name),
          stockCost: Math.round(stockCost),
          coverageDays: usedCost > 0 ? Math.round((stockCost / usedCost) * daysInPeriod) : null,
        });
      }
      continue;
    }
    if (/:\s*$/.test(name)) continue;
    if (stockCost > 0 && !usedUnits && !usedCost) slowMovers.push({ name, stockCost: Math.round(stockCost) });
  }
  slowMovers.sort((a, b) => b.stockCost - a.stockCost);
  return {
    slowMovers: slowMovers.slice(0, 10),
    categoryCoverage: categories.sort((a, b) => (b.stockCost || 0) - (a.stockCost || 0)).slice(0, 12),
  };
}

const KITCHEN_PURCHASE_DEFAULTS = { suggestionDays: 7, extraDays: 1, coverage: 0.25 };

// Cordura de costos unitarios. Sculpture no valida su maestro de articulos: hay
// fichas cargadas con el precio por tonelada o con ceros de mas. Medido (cid
// 26223, pid 119): "Champiñon Ostra" y "Champiñon Portobello" llegan con Costo
// Unitario 9500000.00 por kilo cuando el "Champiñon Paris" de la misma
// categoria vale 7143. Ese costo entra al pedido sugerido y lo infla en
// millones (19.050.001 sugeridos contra 64.287 de compra real).
// Techo robusto por tabla = 50x la mediana de costos unitarios de ESA tabla.
// Calibrado sobre tablas reales: Bardot barra 18,6x (195.375 vs mediana 10.481,
// n=254) es el maximo legitimo observado; Bardot cocina 2,9x; Tio Tomate cocina
// 2,6x sin los champiñones. Los champiñones corruptos estan a 905x. 50 deja
// 2,7x de margen sobre lo legitimo y 18x bajo el defecto.
const UNIT_COST_OUTLIER_FACTOR = 50;
const UNIT_COST_SAMPLE_MIN = 8;

function enrichKitchenIntelipar(rows, { daysInPeriod = 7, params = {} } = {}) {
  const { suggestionDays, extraDays, coverage } = { ...KITCHEN_PURCHASE_DEFAULTS, ...params };
  const hasNativeSuggestion = (rows || []).some((row) => {
    const record = row.record || {};
    return record.par !== undefined || record.orden !== undefined || record.costoPedido !== undefined;
  });
  if (hasNativeSuggestion || !rows?.length) return false;

  // Mediana de costos unitarios de ESTA tabla (solo filas de producto). Se usa
  // la mediana y no el promedio porque el outlier que buscamos arrastraria el
  // promedio: con los dos champiñones de 9.500.000 adentro el promedio de la
  // tabla es 454.000 y el techo queda inservible; la mediana se queda en 10.500
  // y el techo en 525.000.
  const unitCostSamples = rows
    .filter((row) => {
      const name = pickRecordValue(row.record, ["itemName", "item"], "") ||
        pickRecordValueFuzzy(row.record, /nombreArt/i) ||
        row.values?.[0] || "";
      return name && !isTotalRow(name) && !/:\s*$/.test(name);
    })
    .map((row) => parseNumber(pickRecordValueFuzzy(row.record, /costoUnit/i)))
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const medianUnitCost = unitCostSamples.length
    ? (unitCostSamples.length % 2
      ? unitCostSamples[(unitCostSamples.length - 1) / 2]
      : (unitCostSamples[unitCostSamples.length / 2 - 1] + unitCostSamples[unitCostSamples.length / 2]) / 2)
    : 0;
  // Con pocas filas la mediana no significa nada: mejor no filtrar que filtrar
  // mal, el guard queda inactivo (techo infinito).
  const unitCostCeiling = unitCostSamples.length >= UNIT_COST_SAMPLE_MIN && medianUnitCost > 0
    ? medianUnitCost * UNIT_COST_OUTLIER_FACTOR
    : Infinity;

  let pendingOrderCost = 0;
  for (const row of rows) {
    const record = row.record || (row.record = {});
    const name = pickRecordValue(record, ["itemName", "item"], "") ||
      pickRecordValueFuzzy(record, /nombreArt/i) ||
      row.values?.[0] || "";
    if (isTotalRow(name) || /:s*$/.test(name)) {
      // Fila de total de la categoria: acumula el costo de pedido de sus
      // productos para que la compra sugerida por familia salga del mismo
      // lugar que en las tablas de barra.
      record.costoPedido = pendingOrderCost ? `$${Math.round(pendingOrderCost)}` : "";
      pendingOrderCost = 0;
      continue;
    }
    const consumption = parseNumber(pickRecordValueFuzzy(record, /consumoHist/i) || record.consumo || "");
    const onHand = parseNumber(record.existencia);
    const unitCost = parseNumber(pickRecordValueFuzzy(record, /costoUnit/i));
    if (!consumption && !onHand) continue;

    const daily = consumption / Math.max(daysInPeriod, 1);
    // El epsilon evita que el redondeo hacia arriba infle valores exactos por
    // ruido de punto flotante (ej. 92.0000000001 -> 93 en vez de 92).
    const roundUp = (value) => Math.ceil(value - 1e-9);
    const par = roundUp(daily * (suggestionDays + extraDays) * (1 + coverage));
    const suggested = Math.max(roundUp(par - onHand), 0);
    // Si el costo unitario es un outlier de la propia tabla, el dato viene mal
    // desde Sculpture: se conservan las CANTIDADES (par, orden, dias), que no
    // dependen del precio y siguen siendo utiles, pero no se valoriza nada.
    // Valorizar aca es lo que metia 9.500.000 por unidad en el pedido y
    // 3.503.125 en el exceso de UN producto del que se compraron 0 kilos.
    const suspectUnitCost = unitCost > unitCostCeiling;
    const orderCost = suspectUnitCost ? 0 : suggested * unitCost;
    const inventoryDays = consumption > 0 ? Math.round((onHand / consumption) * daysInPeriod) : 0;
    const excessDays = inventoryDays - suggestionDays * 2.5;
    const excessCost = !suspectUnitCost && consumption > 0 && excessDays > 0
      ? Math.round(excessDays * daily * unitCost)
      : 0;

    record.par = String(par);
    record.orden = suggested ? String(suggested) : "";
    record.costoPedido = orderCost ? `$${Math.round(orderCost)}` : "";
    record.excesoDeInventario = excessCost ? `$${excessCost}` : "";
    record.dAsRestantes = inventoryDays ? String(inventoryDays) : "";
    // La fila NO se descarta: se marca, para que la auditora vea el producto y
    // corrija la ficha en Sculpture. Descartarla en silencio seria repetir el
    // problema de los truncados que borran plata sin dejar rastro.
    // El nombre de clave se eligio para no colisionar con ningun accesor fuzzy
    // existente: NO matchea /costoUnit/i, /stock|existenc/i, /sugerid|pedido/i
    // ni /nombreArt/i.
    record.alertaCosto = suspectUnitCost
      ? `Costo unitario atípico en Sculpture (${Math.round(unitCost)}): no se valoriza el pedido`
      : "";
    pendingOrderCost += orderCost;
  }
  return true;
}

async function syncSculptureSources(store, report, requestBody = {}) {
  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const period = store.periods.find((candidate) => candidate.id === report.periodId);
  const { cid, pid, cidSource, pidSource } = resolveSculptureContext({ client, period, requestBody });
  const area = client?.area || requestBody.area || "Food";
  const baseUrl = client?.sculptureBaseUrl || client?.baseUrl || baseUrlForSculptureArea(area);
  const syncResults = {};
  let detailedStockUnits = new Map();

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
          // El variance summary no trae columnas por producto: al fusionar se
          // conservan los campos (usado, inventario, merma) que el detailed
          // ya haya llenado y la otra tabla traiga en cero.
          const merged = { ...metrics.summary };
          for (const [key, value] of Object.entries(report.summary || {})) {
            if (value && !merged[key]) merged[key] = value;
          }
          report.summary = merged;
        }
        // Solo el variance DETAILED define categorias, familias y productos:
        // el summary tiene otra estructura de filas y duplicaba o vaciaba montos.
        if (type === "varianceDetailed") {
          if (metrics.categoryVariances.length) report.categoryVariances = metrics.categoryVariances;
          if (metrics.familyVariances?.some((item) => item.amount)) report.familyVariances = metrics.familyVariances;
          if (metrics.familyPurchases?.some((item) => item.purchased)) report.familyPurchases = metrics.familyPurchases;
          if (metrics.topProducts.length) report.topProducts = metrics.topProducts;
          if (metrics.topUsageProducts?.length) report.topUsageProducts = metrics.topUsageProducts;
        }
        if (type === "varianceDetailed") {
          detailedStockUnits = buildDetailedStockMap(data.rows);
          const syncPeriodMs = period?.startsAt && period?.endsAt
            ? Date.parse(period.endsAt) - Date.parse(period.startsAt)
            : 0;
          report.stockEfficiency = buildStockEfficiency(
            data.rows,
            syncPeriodMs > 0 ? Math.round(syncPeriodMs / 86400000) + 1 : 7,
          );
          const purchaseActuals = extractPurchaseActuals(data);
          if (purchaseActuals.length) report.purchaseActuals = purchaseActuals;
          if (!data.rows?.length) {
            // Sin filas para este periodo: limpiar restos de sincronizaciones
            // anteriores para no mostrar datos que no corresponden.
            report.topProducts = [];
            report.topUsageProducts = [];
            report.categoryVariances = [];
            report.familyVariances = [];
            report.familyPurchases = [];
            report.summary = { revenue: 0, costPercent: 0, idealCostPercent: 0, variancePercent: 0, varianceAmount: 0, usedCost: 0, soldCost: 0, wasteCost: 0, inventoryCost: 0, purchasedCost: 0 };
          }
        }
      }

      if (type === "intelipar") {
        const periodForDays = store.periods.find((candidate) => candidate.id === report.periodId);
        const periodMs = periodForDays?.startsAt && periodForDays?.endsAt
          ? Date.parse(periodForDays.endsAt) - Date.parse(periodForDays.startsAt)
          : 0;
        const daysInPeriod = periodMs > 0 ? Math.round(periodMs / 86400000) + 1 : 7;
        const isKitchenTable = !(data.rows || []).some((row) => {
          const record = row.record || {};
          return record.par !== undefined || record.orden !== undefined || record.costoPedido !== undefined;
        });
        if (isKitchenTable) applyEffectiveInventory(data.rows, detailedStockUnits, client);
        enrichKitchenIntelipar(data.rows, { daysInPeriod, params: client?.purchaseParams });

        // Lo que hay que comprar primero: mayor costo de pedido o exceso.
        const suggestionRows = [...data.rows]
          .filter((row) => {
            const name = pickRecordValue(row.record, ["itemName", "item", "nombreArticulo", "nombreArtículo"], row.values[0] || "");
            return name && !isTotalRow(name) && !/:\s*$/.test(name) && !/grand\s+total/i.test(name);
          })
          // Tres niveles, en este orden:
          // (1) Los productos con costo unitario atipico van PRIMERO: son los
          //     que la auditora tiene que corregir en Sculpture antes de
          //     enviar. Sin esto quedarian con costoPedido y exceso en cero, se
          //     caerian del top-12 y el guard los OCULTARIA en vez de
          //     exponerlos, que es exactamente lo contrario de lo que se busca.
          // (2) Costo de pedido: es la lista de compra.
          // (3) Exceso de inventario como desempate. NO se elimina del ranking:
          //     `slowMovers` exige !usedUnits && !usedCost y `excessCost` exige
          //     consumption > 0, o sea son conjuntos disjuntos y el exceso no
          //     tiene ninguna otra seccion donde aparecer.
          .sort((left, right) => {
            const alertRank = (row) => (pickRecordValue(row.record, ["alertaCosto"], "") ? 1 : 0);
            if (alertRank(right) !== alertRank(left)) return alertRank(right) - alertRank(left);
            const byOrder = parseNumber(right.record?.costoPedido) - parseNumber(left.record?.costoPedido);
            if (byOrder) return byOrder;
            return Math.abs(parseNumber(right.record?.excesoDeInventario)) - Math.abs(parseNumber(left.record?.excesoDeInventario));
          });
        const suggestions = suggestionRows.slice(0, 12).map((row) => {
          const excessCost = parseNumber(pickRecordValue(row.record, ["excesoDeInventario", "excessInventory"], ""));
          const daysRemaining = parseNumber(pickRecordValue(row.record, ["dAsRestantes", "diasRestantes", "daysRemaining"], ""));
          const costAlert = pickRecordValue(row.record, ["alertaCosto"], "");
          const note = costAlert
            ? `${costAlert}${daysRemaining ? `, ${daysRemaining.toFixed(1)} días restantes` : ""}`
            : excessCost
              ? `Exceso ${moneyPlain(excessCost)}${daysRemaining ? `, ${daysRemaining.toFixed(1)} días restantes` : ""}`
              : "Validar proveedor y sugerencia antes del envío";
          return {
            item: pickRecordValue(row.record, ["itemName", "item", "nombreArticulo", "nombreArtículo"], row.values[0] || ""),
            provider: pickRecordValue(row.record, ["provider", "vendor", "proveedor"], "") ||
              pickRecordValueFuzzy(row.record, /proveedor|vendor|provider/i) ||
              row.values[11] || "Por validar",
            stock: cleanCellValue(
              pickRecordValue(row.record, ["stock", "onHand", "stockActual", "existencia"], "") ||
              pickRecordValueFuzzy(row.record, /stock|existenc|enMano|onHand/i, /costo|cost|d[ií]as|dAs|valor/i) ||
              row.values[4] || "",
            ),
            suggested: cleanCellValue(
              pickRecordValue(row.record, ["suggested", "order", "sugerido", "orden"], "") ||
              pickRecordValueFuzzy(row.record, /sugerid|pedido|order/i, /costo|cost|d[ií]as|dAs|fecha|proveedor/i) ||
              row.values[6] || "",
            ),
            note,
          };
        }).filter((row) => row.item && !/:\s*$/.test(row.item) && !/grand\s+total/i.test(row.item) && (row.stock || row.suggested));
        if (suggestions.length) report.purchaseSuggestions = suggestions;

        const suggestedEntries = data.rows
          .filter((row) => {
            const name = pickRecordValue(row.record, ["itemName", "item", "nombreArticulo", "nombreArtículo"], row.values[0] || "");
            return isTotalRow(name) || /:\s*$/.test(name);
          })
          .map((row) => ({
            category: cleanTotalName(pickRecordValue(row.record, ["itemName", "item", "nombreArticulo", "nombreArtículo"], row.values[0] || "")),
            value: parseNumber(
              pickRecordValue(row.record, ["costoPedido", "orderCost", "costoDePedido"], "") ||
              pickRecordValueFuzzy(row.record, /(costo|cost).*(pedido|sugerid|order)|(pedido|order).*(costo|cost)/i),
            ),
          }));
        const familySuggested = aggregateReportGroups(suggestedEntries).map(({ family, value }) => ({ family, suggested: value }));
        if (familySuggested.some((item) => item.suggested)) {
          report.familySuggested = familySuggested;
          report.summary = report.summary || {};
          report.summary.suggestedCost = familySuggested.reduce((total, item) => total + (item.suggested || 0), 0);
        }
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

  if (!(report.summary?.revenue > 0)) {
    // Periodo sin ventas: no dejar listas residuales de sincronizaciones viejas.
    report.topProducts = [];
    report.topUsageProducts = [];
    report.categoryVariances = [];
    report.familyVariances = [];
    report.familyPurchases = [];
  }

  report.updatedAt = new Date().toISOString();
  report.analysis = null;
  return syncResults;
}

function periodMonthKey(period) {
  const date = period?.startsAt || period?.endsAt || "";
  return String(date).slice(0, 7);
}

function resolvePeriodsForSculptureQuery(store, { periods = [], periodId = "", fromMonth = "", toMonth = "", cid = "" } = {}) {
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

  // Los ids de periodo estan namespaced por cliente (`sculpture-<cid>-<pid>`) y
  // el mismo pid existe para varios cid (18 periodos comparten el pid 41).
  // Buscar primero en store.periods (GLOBAL) hacia que el periodo de otro
  // restaurante ganara: asi 28711-barra (Bardot) quedo con `sculpture-29087-41`
  // (Azotea) y sincronizo su propio pid 41 = FEBRERO con etiqueta de julio.
  const belongsToClient = (period) => {
    const namespaced = /^sculpture-(\d+)-/.exec(String(period?.id || ""));
    if (!namespaced) return true; // periodo legacy/manual, sin namespace
    return !cid || namespaced[1] === String(cid);
  };
  // Sin periodo explicito: usar la ultima semana CERRADA. Sculpture tambien
  // lista el periodo abierto en curso (ej. "Jul 23 to Jul 24"), que aun no
  // tiene auditoria y generaba reportes vacios o a medias. Va con la misma
  // guarda por cliente: sin ella, la "ultima semana cerrada" podia ser la de
  // otro restaurante.
  const today = new Date().toISOString().slice(0, 10);
  const latestClosed = availablePeriods.find((period) =>
    period.endsAt && period.endsAt < today && belongsToClient(period));

  // OJO: el fallback tambien lleva guarda. Cuando Sculpture no devuelve periodos
  // del cliente, `availablePeriods` ES `store.periods`, asi que
  // `availablePeriods[0]` no es "la semana mas reciente del cliente": es
  // store.periods[0] para cualquiera. Sin filtrar aca, el defecto vuelve a
  // entrar por esa puerta.
  const selected = availablePeriods.find((period) => period.id === periodId && belongsToClient(period)) ||
    store.periods.find((period) => period.id === periodId && belongsToClient(period)) ||
    latestClosed ||
    availablePeriods.filter(belongsToClient)[0] ||
    null;
  if (!selected) return [];

  return [selected];
}

function periodSortKey(payload) {
  return String(payload?.period?.startsAt || payload?.period?.endsAt || payload?.updatedAt || "");
}

function summaryUsedCost(summary = {}) {
  if (Number.isFinite(summary.usedCost)) return summary.usedCost;
  return ((summary.costPercent || 0) / 100) * (summary.revenue || 0);
}

function summarySoldCost(summary = {}) {
  if (Number.isFinite(summary.soldCost)) return summary.soldCost;
  if (summary.variancePercent) return (summary.varianceAmount || 0) / (summary.variancePercent / 100);
  return 0;
}

// Acumula varios reportes semanales en uno mensual: los flujos (ingresos, ventas,
// costo usado, variacion) se SUMAN; las existencias/stock (sugerencia de compra)
// se toman del ULTIMO periodo, tal como opera Sculpture.
function accumulateReportPayloads(payloads = []) {
  const valid = payloads.filter(Boolean);
  if (!valid.length) return null;

  const ordered = [...valid].sort((left, right) => periodSortKey(left).localeCompare(periodSortKey(right)));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  let revenue = 0;
  let usedCost = 0;
  let soldCost = 0;
  let varianceAmount = 0;
  // El ahorro del mes es la suma de los ahorros de CADA semana (positivos por
  // semana), no el neto por familia: una familia +10 y -4 en semanas distintas
  // aporta 10 al ahorro y -4 al faltante, no +6 al ahorro.
  let savingsTotal = 0;
  let shortagesTotal = 0;
  let wasteCost = 0;
  let purchasedCost = 0;
  let suggestedCost = 0;
  const categoryMap = new Map();
  const productMap = new Map();
  const familyMap = new Map();
  const familyPurchaseMap = new Map();
  const familySuggestedMap = new Map();
  const usageMap = new Map();
  const monthlyHistory = [];

  for (const payload of ordered) {
    const summary = payload.summary || {};
    revenue += summary.revenue || 0;
    usedCost += summaryUsedCost(summary);
    soldCost += summarySoldCost(summary);
    varianceAmount += summary.varianceAmount || 0;
    wasteCost += summary.wasteCost || 0;
    purchasedCost += summary.purchasedCost || 0;
    suggestedCost += summary.suggestedCost || 0;

    for (const family of payload.familyVariances || []) {
      familyMap.set(family.family, (familyMap.get(family.family) || 0) + (family.amount || 0));
      if ((family.amount || 0) > 0) savingsTotal += family.amount;
      else shortagesTotal += family.amount || 0;
    }
    for (const family of payload.familyPurchases || []) {
      familyPurchaseMap.set(family.family, (familyPurchaseMap.get(family.family) || 0) + (family.purchased || 0));
    }
    for (const family of payload.familySuggested || []) {
      familySuggestedMap.set(family.family, (familySuggestedMap.get(family.family) || 0) + (family.suggested || 0));
    }

    monthlyHistory.push({
      periodId: payload.periodId,
      label: payload.period?.label || payload.periodId,
      endsAt: payload.period?.endsAt || "",
      revenue: summary.revenue || 0,
      costPercent: summary.costPercent || 0,
      idealCostPercent: summary.idealCostPercent || 0,
      varianceAmount: summary.varianceAmount || 0,
      usedCost: summaryUsedCost(summary),
      inventoryCost: summary.inventoryCost || 0,
      purchasedCost: summary.purchasedCost || 0,
      suggestedCost: summary.suggestedCost || 0,
    });

    // Uso ($) por producto: se suman las semanas para que la tabla de
    // "10 productos con mayor uso" tenga datos en el reporte mensual.
    for (const product of payload.topUsageProducts || []) {
      const key = `${product.name || "Sin nombre"}::${product.category || ""}`;
      const current = usageMap.get(key) || {
        name: product.name || "Sin nombre",
        category: product.category || "",
        usedCost: 0,
        varianceAmount: 0,
        realCostBase: 0,
        variancePctBase: 0,
      };
      current.usedCost += product.usedCost || 0;
      current.varianceAmount += product.varianceAmount || 0;
      // Promedios ponderados por el uso de cada semana.
      current.realCostBase += (product.realCostPercent || 0) * (product.usedCost || 0);
      current.variancePctBase += (product.variancePercent || 0) * (product.usedCost || 0);
      usageMap.set(key, current);
    }

    for (const category of payload.categoryVariances || []) {
      const key = category.category || "Sin categoría";
      const current = categoryMap.get(key) || { category: key, amount: 0 };
      current.amount += category.amount || 0;
      categoryMap.set(key, current);
    }

    for (const product of payload.topProducts || []) {
      const key = `${product.name || "Sin nombre"}::${product.category || ""}`;
      const current = productMap.get(key) || {
        name: product.name || "Sin nombre",
        category: product.category || "",
        varianceAmount: 0,
      };
      current.varianceAmount += product.varianceAmount || 0;
      productMap.set(key, current);
    }
  }

  const round1 = (value) => Number((value || 0).toFixed(1));
  const categoryVariances = [...categoryMap.values()]
    .map((item) => ({
      ...item,
      percent: soldCost ? round1((item.amount / soldCost) * 100) : 0,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const topProducts = [...productMap.values()]
    .map((item) => ({
      ...item,
      variancePercent: soldCost ? round1((item.varianceAmount / soldCost) * 100) : 0,
    }))
    .sort((a, b) => Math.abs(b.varianceAmount) - Math.abs(a.varianceAmount))
    .slice(0, 10);
  const topUsageProducts = [...usageMap.values()]
    .filter((item) => item.usedCost > 0)
    .map((item) => ({
      name: item.name,
      category: item.category,
      usedCost: Math.round(item.usedCost),
      varianceAmount: Math.round(item.varianceAmount),
      variancePercent: round1(item.variancePctBase / item.usedCost),
      realCostPercent: round1(item.realCostBase / item.usedCost),
    }))
    .sort((a, b) => b.usedCost - a.usedCost)
    .slice(0, 10);

  const includedPeriods = ordered.map((payload) => ({
    id: payload.periodId,
    label: payload.period?.label || payload.periodId,
    startsAt: payload.period?.startsAt || "",
    endsAt: payload.period?.endsAt || "",
  }));

  return {
    id: `accumulated-${first.clientId || "cliente"}`,
    clientId: first.clientId,
    isAccumulated: true,
    status: "Borrador",
    client: first.client,
    period: {
      id: `accumulated-${includedPeriods.map((item) => item.id).join("-")}`,
      label: `Acumulado ${first.period?.label || ""} -> ${last.period?.label || ""}`.trim(),
      startsAt: first.period?.startsAt || "",
      endsAt: last.period?.endsAt || "",
    },
    includedPeriods,
    summary: {
      revenue,
      usedCost,
      soldCost,
      wasteCost,
      purchasedCost,
      suggestedCost,
      // Las existencias son una foto: se toma la del ULTIMO periodo del mes.
      inventoryCost: last.summary?.inventoryCost || 0,
      idealCostPercent: last.summary?.idealCostPercent || 0,
      costPercent: revenue ? round1((usedCost / revenue) * 100) : 0,
      variancePercent: soldCost ? round1((varianceAmount / soldCost) * 100) : 0,
      varianceAmount,
      savingsTotal: Math.round(savingsTotal),
      shortagesTotal: Math.round(shortagesTotal),
    },
    categoryVariances,
    topProducts,
    topUsageProducts,
    familyVariances: [...familyMap.entries()]
      .map(([family, amount]) => ({ family, amount: Math.round(amount) }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    familyPurchases: [...familyPurchaseMap.entries()].map(([family, purchased]) => ({ family, purchased: Math.round(purchased) })),
    familySuggested: [...familySuggestedMap.entries()].map(([family, suggested]) => ({ family, suggested: Math.round(suggested) })),
    monthlyHistory,
    // Las existencias/stock son una foto: se toman del ultimo periodo, no se suman.
    stockEfficiency: last.stockEfficiency || null,
    purchaseSuggestions: last.purchaseSuggestions || [],
    sourceStatus: last.sourceStatus || {},
  };
}

function buildReportPayload(store, report) {
  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const period = store.periods.find((candidate) => candidate.id === report.periodId);

  const payload = {
    ...report,
    client,
    period,
    // Los reportes mensuales traen su propio historial: las semanas del mes.
    history: Array.isArray(report.monthlyHistory) && report.monthlyHistory.length
      ? report.monthlyHistory
      : historyForReport(store, report),
    criteriaDocuments: store.criteriaDocuments || [],
    allClientNames: (store.clients || []).map((item) => item.name),
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
  const height = 330;
  const axisLabelX = 70;
  const gridLeft = 126;
  const plotLeft = 205;
  const right = 56;
  const top = 28;
  const bottom = 62;
  const chartWidth = width - plotLeft - right;
  const chartHeight = height - top - bottom;
  const baseline = top + chartHeight;
  const revenueBarHeight = chartHeight * 0.58;
  const percentTop = top + 32;
  const percentHeight = 132;
  const maxRevenue = Math.max(...rows.map((item) => item.revenue || 0), 1);
  const maxObservedPercent = Math.max(...rows.flatMap((item) => [item.costPercent || 0, item.idealCostPercent || 0]), 0);
  const percentScaleMax = Math.max(60, Math.ceil((maxObservedPercent + 8) / 15) * 15);
  const percentTicks = Array.from({ length: 5 }, (_, index) => (percentScaleMax / 4) * index);
  const step = rows.length > 1 ? chartWidth / (rows.length - 1) : chartWidth;
  const realPoints = [];
  const idealPoints = [];
  const bars = rows
    .map((item, index) => {
      const x = plotLeft + index * step;
      const barHeight = ((item.revenue || 0) / maxRevenue) * revenueBarHeight;
      const barWidth = Math.min(88, chartWidth / Math.max(rows.length, 1) * 0.42);
      const barY = baseline - barHeight;
      const real = item.costPercent || 0;
      const ideal = item.idealCostPercent || 0;
      const realY = percentTop + percentHeight - (Math.min(real, percentScaleMax) / percentScaleMax) * percentHeight;
      const idealY = percentTop + percentHeight - (Math.min(ideal, percentScaleMax) / percentScaleMax) * percentHeight;
      const realBadgeY = Math.max(top + 8, Math.min(realY - 38, barY - 34));
      realPoints.push(`${x},${realY}`);
      idealPoints.push(`${x},${idealY}`);

      return `
        <rect x="${x - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="#8bc6c1" />
        <text x="${x}" y="${baseline + 34}" text-anchor="middle" class="axis-label">${escapeHtml(shortPeriodLabel(item.label))}</text>
        <text x="${x}" y="${Math.max(barY + 22, top + 24)}" text-anchor="middle" class="bar-value">${compactMoney(item.revenue)}</text>
        <rect x="${x - 38}" y="${realBadgeY}" width="76" height="30" rx="6" fill="#001e43" />
        <text x="${x}" y="${realBadgeY + 21}" text-anchor="middle" class="point-label">${real.toFixed(1)}%</text>
        <circle cx="${x}" cy="${idealY}" r="4" fill="#90bf4f" />`;
    })
    .join("");
  const grid = percentTicks.map((tick) => {
    const y = percentTop + percentHeight - (tick / percentScaleMax) * percentHeight;
    return `<line x1="${gridLeft}" x2="${width - right}" y1="${y}" y2="${y}" stroke="#edf1f0" /><text x="${axisLabelX}" y="${y + 5}" text-anchor="end" class="axis-label">${Math.round(tick)}%</text>`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ingresos y porcentaje de costo real">
    <style>.axis-label{font:18px Ubuntu,Arial;fill:#66706d}.bar-value{font:700 20px Ubuntu,Arial;fill:#fff}.point-label{font:700 16px Ubuntu,Arial;fill:#fff}</style>
    ${grid}
    ${bars}
    <polyline points="${idealPoints.join(" ")}" fill="none" stroke="#90bf4f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="${realPoints.join(" ")}" fill="none" stroke="#001e43" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    <g transform="translate(${plotLeft + 275},${height - 16})">
      <rect width="18" height="6" fill="#8bc6c1" /><text x="26" y="6" class="axis-label">Suma de ingresos</text>
      <line x1="210" x2="244" y1="3" y2="3" stroke="#001e43" stroke-width="5" /><text x="254" y="6" class="axis-label">% costo real</text>
      <line x1="410" x2="444" y1="3" y2="3" stroke="#90bf4f" stroke-width="4" /><text x="454" y="6" class="axis-label">% costo ideal</text>
    </g>
  </svg>`;
}

function renderVarianceSvg(items, money) {
  const rows = items
    .filter((item) => Math.abs(item.amount ?? item.varianceAmount ?? 0) > 0)
    .slice(0, 8);
  const width = 980;
  const rowHeight = 40;
  const height = 82 + rows.length * rowHeight;
  const labelX = 18;
  const labelWidth = 250;
  const center = 565;
  const negativeMaxWidth = 230;
  const positiveMaxWidth = 320;
  const maxValue = Math.max(...rows.map((item) => Math.abs(item.amount || item.varianceAmount || 0)), 1);
  if (!rows.length) {
    return `<svg class="report-svg" viewBox="0 0 ${width} 230" role="img" aria-label="Sin ahorro o faltantes relevantes">
      <style>.empty-title{font:700 24px Ubuntu,Arial;fill:#393939}.empty-text{font:18px Ubuntu,Arial;fill:#66706d}</style>
      <rect x="16" y="18" width="${width - 32}" height="194" rx="8" fill="#f6f8f7" stroke="#e1e8e6" />
      <text x="${width / 2}" y="96" text-anchor="middle" class="empty-title">Sin ahorro/faltantes relevantes</text>
      <text x="${width / 2}" y="132" text-anchor="middle" class="empty-text">No hay diferencias monetarias para graficar en este periodo.</text>
    </svg>`;
  }
  const rowMarkup = rows.map((item, index) => {
    const amount = item.amount ?? item.varianceAmount ?? 0;
    const label = item.name || item.category || "Sin nombre";
    const subtitle = item.name ? item.category : "";
    const y = 58 + index * rowHeight;
    const isNegative = amount < 0;
    const maxBarWidth = isNegative ? negativeMaxWidth : positiveMaxWidth;
    const barWidth = Math.max(12, (Math.abs(amount) / maxValue) * maxBarWidth);
    const x = isNegative ? center - barWidth : center;
    const color = isNegative ? "#9f674f" : "#90bf4f";
    const textX = isNegative ? x - 6 : x + barWidth + 6;
    const textAnchor = isNegative ? "end" : "start";
    return `
      <text x="${labelX}" y="${y - 4}" class="category-label">${escapeHtml(truncateLabel(label, 30))}</text>
      ${subtitle ? `<text x="${labelX}" y="${y + 12}" class="category-sub">${escapeHtml(truncateLabel(subtitle, 28))}</text>` : ""}
      <rect x="${x}" y="${y - 15}" width="${barWidth}" height="18" rx="3" fill="${color}" />
      <text x="${textX}" y="${y - 2}" text-anchor="${textAnchor}" class="amount-label">${compactMoney(amount)}</text>`;
  }).join("");

  return `<svg class="report-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ahorro y faltantes de inventario">
    <style>.category-label{font:700 20px Ubuntu,Arial;fill:#393939}.category-sub{font:17px Ubuntu,Arial;fill:#66706d}.amount-label{font:700 18px Ubuntu,Arial;fill:#393939}</style>
    <line x1="${labelWidth}" x2="${labelWidth}" y1="28" y2="${height - 18}" stroke="#eef2f1" />
    <line x1="${center}" x2="${center}" y1="34" y2="${height - 20}" stroke="#dfe5e3" />
    <text x="${center - 128}" y="22" text-anchor="middle" class="category-sub">Faltantes</text>
    <text x="${center + 150}" y="22" text-anchor="middle" class="category-sub">Ahorros</text>
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
      ${renderAnalysisList("Los desafíos de la semana", analysis.weeklyChallenges || [])}
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
  const analysis = payload.analysis || generateReportAnalysis(payload);

  // ---- Paleta del reporte Bevinco (identica al modelo Excel) ----
  const NAVY = "#16365d";
  const GREEN = "#90bf4f";
  const TEAL = "#8bc6c1";
  const GRAY_TXT = "#595959";
  const FAMILY_COLORS = {
    "Destilados": "#10243e",
    "Vinos": "#2e75b6",
    "Espumantes": "#90bf4f",
    "Cervezas y Sidra": "#8bc6c1",
    "Barriles": "#8c5f42",
    "Sin Alcohol": "#a6a6a6",
    "Otros": "#c9b26a",
  };

  // ---- Formatos ----
  const usInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const fmtMoney = (value) => usInt.format(Math.round(value || 0));
  const fmtK = (value) => {
    const v = value || 0;
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return `${Math.round(v)}`;
  };
  const fmtPct = (value) => `${(value || 0).toFixed(1)}%`;
  const ddmm = (iso) => {
    const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}-${match[2]}` : "";
  };
  const ddmmyyyy = (iso) => {
    const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
  };
  const niceCeil = (value, step) => Math.max(step, Math.ceil((value || 0) / step) * step);
  // Paso "bonito" para ejes segun la magnitud de los datos (1/2/2.5/5 x 10^n).
  const niceStep = (maxValue, ticks = 5) => {
    const rough = Math.max(1, (maxValue || 1) / ticks);
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    for (const base of [1, 2, 2.5, 5, 10]) {
      if (base * power >= rough) return base * power;
    }
    return 10 * power;
  };
  const paletteFor = (name, index) =>
    FAMILY_COLORS[name] || ["#10243e", "#2e75b6", "#90bf4f", "#8bc6c1", "#8c5f42", "#a6a6a6", "#c9b26a"][index % 7];

  // ---- Datos ----
  const history = [...(payload.history || [])].sort((a, b) => String(a.endsAt || a.label).localeCompare(String(b.endsAt || b.label)));
  const familyVariances = (payload.familyVariances && payload.familyVariances.length
    ? payload.familyVariances
    : REPORT_FAMILIES.map((family) => ({ family, amount: 0 })));
  const purchasesMap = new Map((payload.familyPurchases || []).map((item) => [item.family, item.purchased || 0]));
  const suggestedMap = new Map((payload.familySuggested || []).map((item) => [item.family, item.suggested || 0]));
  const familyNames = [...new Set([...purchasesMap.keys(), ...suggestedMap.keys(), ...REPORT_FAMILIES])];
  const familyPurchaseRows = familyNames
    .map((family) => ({
      family,
      purchased: purchasesMap.get(family) || 0,
      suggested: suggestedMap.get(family) || 0,
    }))
    .sort((left, right) => (right.purchased + right.suggested) - (left.purchased + left.suggested))
    .slice(0, 7);
  const savings = Number.isFinite(payload.summary?.savingsTotal)
    ? payload.summary.savingsTotal
    : familyVariances.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0);
  const shortages = Number.isFinite(payload.summary?.shortagesTotal)
    ? payload.summary.shortagesTotal
    : familyVariances.filter((item) => item.amount < 0).reduce((sum, item) => sum + item.amount, 0);
  const waste = Math.abs(payload.summary?.wasteCost || 0);
  const tableProducts = (payload.topUsageProducts && payload.topUsageProducts.length
    ? payload.topUsageProducts
    : (payload.topProducts || []).map((item) => ({
        name: item.name,
        usedCost: 0,
        varianceAmount: item.varianceAmount,
        variancePercent: item.variancePercent,
        realCostPercent: 0,
      }))).slice(0, 10);
  const clientTitle = payload.client?.accountName || payload.client?.name || report.clientId;
  const isMonthlyReport = Boolean(report.monthly || payload.isAccumulated);

  // ---- Grafico 1: Costo real vs Costo Ideal (barras + 2 lineas) ----
  function costComboSvg() {
    const W = 700; const H = 252;
    const L = 56; const R = 644; const T = 30; const B = 186;
    const plotW = R - L; const plotH = B - T;
    const n = Math.max(history.length, 1);
    const revStep = niceStep(Math.max(...history.map((p) => p.revenue || 0), 1) * 1.15);
    const revMax = niceCeil(Math.max(...history.map((p) => p.revenue || 0), 1) * 1.15, revStep);
    // Eje de % acotado al rango real de los datos (con margen): con la escala
    // 0..45 las curvas de costo (22-28%) se veian como lineas planas
    // indistinguibles (pedido de Pedro, reunion 27-jul).
    const pctValues = history.flatMap((p) => [p.costPercent || 0, p.idealCostPercent || 0]).filter((value) => value > 0);
    const pctHigh = Math.max(...(pctValues.length ? pctValues : [1]));
    const pctLow = pctValues.length ? Math.min(...pctValues) : 0;
    const pctMax = niceCeil(pctHigh + 3, 5);
    const pctMin = Math.max(0, Math.floor((pctLow - 3) / 5) * 5);
    const xAt = (i) => L + ((i + 0.5) * plotW) / n;
    const yPct = (v) => B - (((v || 0) - pctMin) / Math.max(pctMax - pctMin, 1)) * plotH;
    const yRev = (v) => B - ((v || 0) / revMax) * plotH;
    const ticks = [];
    for (let v = pctMin; v <= pctMax; v += 5) ticks.push(v);
    const grid = ticks.map((v) =>
      `<line x1="${L}" y1="${yPct(v)}" x2="${R}" y2="${yPct(v)}" stroke="#e3e3e3" stroke-width="1"/>` +
      `<text x="${L - 6}" y="${yPct(v) + 3}" text-anchor="end" class="ax">${v.toFixed(1)}%</text>`).join("");
    const rightTicks = [];
    for (let v = 0; v <= revMax; v += revStep) rightTicks.push(v);
    const rightAxis = rightTicks.map((v) =>
      `<text x="${R + 8}" y="${yRev(v) + 3}" class="ax">${v ? fmtK(v) : "K"}</text>`).join("");
    const bars = history.map((p, i) => {
      if (!p.revenue) return "";
      const x = xAt(i) - 21;
      const y = yRev(p.revenue);
      const barHeight = B - y;
      // La cifra va pegada a la base de la barra (como el reporte modelo);
      // si la barra es muy corta, se coloca sobre ella en gris.
      const label = barHeight > 26
        ? `<text x="${xAt(i)}" y="${B - 9}" text-anchor="middle" class="barlab">${fmtK(p.revenue)}</text>`
        : `<text x="${xAt(i)}" y="${y - 5}" text-anchor="middle" class="barlab-out">${fmtK(p.revenue)}</text>`;
      return `<rect x="${x}" y="${y}" width="42" height="${Math.max(2, barHeight)}" fill="${TEAL}"/>` + label;
    }).join("");
    const linePath = (key, color) => {
      const present = history.map((p, i) => ({ p, i })).filter(({ p }) => p[key]);
      if (!present.length) return "";
      const pts = present.map(({ p, i }) => `${xAt(i)},${yPct(p[key])}`).join(" ");
      return (present.length > 1 ? `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.4"/>` : "") +
        present.map(({ p, i }) => `<circle cx="${xAt(i)}" cy="${yPct(p[key])}" r="2.6" fill="${color}"/>`).join("");
    };
    const clampChip = (cy) => Math.min(Math.max(cy, T + 9), B - 10);
    const chips = history.map((p, i) => {
      if (!p.costPercent && !p.idealCostPercent) return "";
      const x = xAt(i);
      const yr = yPct(p.costPercent); const yi = yPct(p.idealCostPercent);
      const realAbove = yr <= yi;
      let cyReal = clampChip(realAbove ? yr - 14 : yr + 16);
      let cyIdeal = clampChip(realAbove ? yi + 16 : yi - 14);
      if (Math.abs(cyReal - cyIdeal) < 21) cyIdeal = clampChip(cyReal - 23) === cyReal ? cyReal + 23 : cyReal - 23;
      const chip = (cy, color, text) =>
        `<g><rect x="${x - 31}" y="${cy - 10}" width="62" height="19" rx="2" fill="${color}"/>` +
        `<text x="${x}" y="${cy + 4}" text-anchor="middle" class="chip">${text}</text></g>`;
      return (p.costPercent ? chip(cyReal, NAVY, fmtPct(p.costPercent)) : "") +
        (p.idealCostPercent ? chip(cyIdeal, GREEN, fmtPct(p.idealCostPercent)) : "");
    }).join("");
    const xLabels = history.map((p, i) =>
      `<text x="${xAt(i)}" y="${B + 16}" text-anchor="middle" class="ax">${ddmmyyyy(p.endsAt) || escapeHtml(p.label)}</text>`).join("");
    const legendY = H - 8;
    return `<svg class="bv-svg" viewBox="0 0 ${W} ${H}">
      <style>.ax{font:12px Calibri,Arial;fill:#808080}.barlab{font:700 14.5px Calibri,Arial;fill:#fff}.barlab-out{font:700 12.5px Calibri,Arial;fill:#8c8c8c}.chip{font:700 12.5px Calibri,Arial;fill:#fff}.leg{font:12.5px Calibri,Arial;fill:${GRAY_TXT}}</style>
      ${grid}${rightAxis}${bars}
      ${linePath("costPercent", NAVY)}${linePath("idealCostPercent", GREEN)}
      ${chips}${xLabels}
      <line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="#bfbfbf"/>
      <g>
        <rect x="${W / 2 - 150}" y="${legendY - 8}" width="10" height="10" fill="${TEAL}"/><text x="${W / 2 - 136}" y="${legendY + 1}" class="leg">Suma de Ingresos</text>
        <line x1="${W / 2 - 40}" y1="${legendY - 3}" x2="${W / 2 - 20}" y2="${legendY - 3}" stroke="${NAVY}" stroke-width="2.4"/><text x="${W / 2 - 16}" y="${legendY + 1}" class="leg">% Costo Real</text>
        <line x1="${W / 2 + 62}" y1="${legendY - 3}" x2="${W / 2 + 82}" y2="${legendY - 3}" stroke="${GREEN}" stroke-width="2.4"/><text x="${W / 2 + 86}" y="${legendY + 1}" class="leg">% Costo Ideal</text>
      </g>
    </svg>`;
  }

  // ---- Grafico 2: Ahorro/faltantes inventario por familia (barras divergentes) ----
  function familyVarianceSvg() {
    const W = 470; const H = 240;
    const L = 150; const R = 452; const T = 22; const B = 200;
    const plotW = R - L; const plotH = B - T;
    const nonZero = familyVariances.filter((item) => item.amount);
    const rows = nonZero.length ? nonZero : familyVariances.slice(0, 6);
    // Escala adaptativa: antes se redondeaba a multiplos de 50K y en locales
    // chicos (max 12K) las barras quedaban aplastadas en el centro.
    const rawAbs = Math.max(...rows.map((item) => Math.abs(item.amount)), 1) * 1.15;
    const maxAbs = niceCeil(rawAbs, niceStep(rawAbs, 3));
    const xAt = (v) => L + ((v + maxAbs) / (2 * maxAbs)) * plotW;
    const ticks = [];
    for (let v = -maxAbs; v <= maxAbs; v += maxAbs / 3) ticks.push(v);
    // Ticks limpios sin decimales ("-15K", "K", "15K"), como la referencia.
    const tickLabel = (v) => {
      if (v === 0) return "K";
      if (Math.abs(v) >= 1e6) return fmtK(v);
      const thousands = v / 1000;
      return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
    };
    const grid = ticks.map((v) =>
      `<line x1="${xAt(v)}" y1="${T}" x2="${xAt(v)}" y2="${B}" stroke="#e6e6e6"/>` +
      `<text x="${xAt(v)}" y="${B + 12}" text-anchor="middle" class="ax">${tickLabel(v)}</text>`).join("");
    const rowH = plotH / Math.max(rows.length, 1);
    // Referencia del equipo: barras gruesas (llenan la fila) y la cifra en un
    // chip del color de la barra pegado a su EXTREMO, por fuera: el largo de
    // la barra sigue siendo la unica codificacion del valor.
    // Sin espacio entre barras: cada una ocupa su fila completa, como la referencia.
    const barH = rowH;
    const bars = rows.map((item, i) => {
      const color = paletteFor(item.family, i);
      const yc = T + (i + 0.5) * rowH;
      const x0 = xAt(0); const x1 = xAt(item.amount);
      const bx = Math.min(x0, x1); const bw = Math.max(2, Math.abs(x1 - x0));
      const positive = item.amount >= 0;
      const label = fmtK(item.amount).replace(/([KM])$/, " $1");
      const chipW = 12 + label.length * 7.2;
      const chipX = positive
        ? Math.min(x1 + 1, W - chipW - 2)
        : Math.max(x1 - 1 - chipW, 2);
      return `<rect x="${bx}" y="${yc - barH / 2}" width="${bw}" height="${barH}" fill="${color}"/>` +
        `<rect x="${chipX}" y="${yc - barH / 2}" width="${chipW}" height="${barH}" fill="${color}"/>` +
        `<text x="${chipX + chipW / 2}" y="${yc + 4.5}" text-anchor="middle" class="chip">${label}</text>`;
    }).join("");
    const legend = rows.map((item, i) =>
      `<rect x="8" y="${T + 12 + i * 22}" width="9" height="9" fill="${paletteFor(item.family, i)}"/>` +
      `<text x="21" y="${T + 20 + i * 22}" class="leg">${escapeHtml(item.family)}</text>`).join("");
    return `<svg class="bv-svg" viewBox="0 0 ${W} ${H}">
      <style>.ax{font:12px Calibri,Arial;fill:#808080}.chip{font:700 12px Calibri,Arial;fill:#fff}.leg{font:700 12.5px Calibri,Arial;fill:#404040}</style>
      ${grid}
      <line x1="${xAt(0)}" y1="${T}" x2="${xAt(0)}" y2="${B}" stroke="#9a9a9a"/>
      ${bars}${legend}
    </svg>`;
  }

  // ---- Pagina 2: Compra realizada vs sugerida (areas) ----
  function purchaseAreaSvg() {
    const W = 340; const H = 230;
    const L = 46; const R = 326; const T = 26; const B = 172;
    const plotW = R - L; const plotH = B - T;
    const n = Math.max(history.length, 1);
    const rawMaxPurchase = Math.max(...history.map((p) => Math.max(p.purchasedCost || 0, p.suggestedCost || 0)), 0);
    const stepP = niceStep(Math.max(rawMaxPurchase, 1) * 1.15);
    const maxV = niceCeil(Math.max(rawMaxPurchase, 1) * 1.15, stepP);
    const xAt = (i) => L + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
    const yAt = (v) => B - ((v || 0) / maxV) * plotH;
    const ticks = [];
    for (let v = 0; v <= maxV; v += stepP) ticks.push(v);
    const grid = ticks.map((v) =>
      `<line x1="${L}" y1="${yAt(v)}" x2="${R}" y2="${yAt(v)}" stroke="#e6e6e6"/>` +
      `<text x="${L - 5}" y="${yAt(v) + 3}" text-anchor="end" class="ax">${v ? fmtK(v) : "0"}</text>`).join("");
    // Dibuja solo los tramos con dato real (>0). Las semanas sin reporte
    // guardado no tienen sugerencia: antes se pintaban como caidas falsas a 0.
    const drawSeries = (values, color, opacity) => {
      const segments = [];
      let segment = [];
      values.forEach((value, i) => {
        if (value > 0) segment.push({ value, i });
        else { if (segment.length) segments.push(segment); segment = []; }
      });
      if (segment.length) segments.push(segment);
      return segments.map((points) => {
        if (points.length === 1) {
          const { value, i } = points[0];
          return `<circle cx="${xAt(i)}" cy="${yAt(value)}" r="3.4" fill="${color}"/>`;
        }
        const pts = points.map(({ value, i }) => `${xAt(i)},${yAt(value)}`).join(" ");
        return `<polygon points="${xAt(points[0].i)},${B} ${pts} ${xAt(points[points.length - 1].i)},${B}" fill="${color}" opacity="${opacity}"/>` +
          `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
      }).join("");
    };
    // La sugerencia de la semana N se compra en la semana N+1: se desplaza la
    // serie una semana hacia adelante para que la comparacion contra la compra
    // realizada sea temporalmente coherente (pedido de Pedro, reunion 17-jul).
    // Para la PRIMERA semana de la ventana, la sugerencia correspondiente es
    // la generada la semana previa: se rescata de los reportes ya guardados
    // del cliente para que el grafico no arranque vacio.
    const purchasedSeries = history.map((p) => p.purchasedCost || 0);
    const firstEndsAt = String(history[0]?.endsAt || "");
    let previousSuggested = 0;
    if (firstEndsAt) {
      const prior = (store.reports || [])
        .filter((candidate) => candidate.clientId === report.clientId && !candidate.monthly && (candidate.summary?.suggestedCost || 0) > 0)
        .map((candidate) => ({ candidate, period: store.periods.find((item) => item.id === candidate.periodId) }))
        .filter(({ period }) => period?.endsAt && String(period.endsAt) < firstEndsAt && !String(period.id || "").startsWith("mensual-"))
        .sort((left, right) => String(right.period.endsAt).localeCompare(String(left.period.endsAt)))[0];
      previousSuggested = prior?.candidate.summary?.suggestedCost || 0;
    }
    const suggestedShifted = history.map((p, i) => (i > 0 ? history[i - 1].suggestedCost || 0 : previousSuggested));
    const xLabels = history.map((p, i) =>
      `<text x="${xAt(i)}" y="${B + 13}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" class="ax">${ddmmyyyy(p.endsAt) || escapeHtml(p.label)}</text>`).join("");
    const legendY = H - 8;
    const emptyNote = rawMaxPurchase
      ? ""
      : `<text x="${(L + R) / 2}" y="${(T + B) / 2}" text-anchor="middle" class="leg">Sin datos de compra para las semanas consultadas.</text>`;
    return `<svg class="bv-svg" viewBox="0 0 ${W} ${H}">
      <style>.ax{font:10.5px Calibri,Arial;fill:#808080}.leg{font:11.5px Calibri,Arial;fill:${GRAY_TXT}}</style>
      ${grid}${emptyNote}
      ${rawMaxPurchase ? drawSeries(suggestedShifted, GREEN, 0.5) + drawSeries(purchasedSeries, NAVY, 0.42) : ""}
      ${xLabels}
      <line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="#bfbfbf"/>
      <rect x="${W / 2 - 108}" y="${legendY - 8}" width="9" height="9" fill="${GREEN}"/><text x="${W / 2 - 96}" y="${legendY}" class="leg">Compra Sugerida</text>
      <rect x="${W / 2 + 4}" y="${legendY - 8}" width="9" height="9" fill="${NAVY}"/><text x="${W / 2 + 16}" y="${legendY}" class="leg">Compra Realizada</text>
    </svg>`;
  }

  // ---- Pagina 2: Cobertura de inventario (barras + linea de dias) ----
  function coverageSvg() {
    const W = 340; const H = 252;
    const L = 48; const R = 296; const T = 26; const B = 188;
    const plotW = R - L; const plotH = B - T;
    const n = Math.max(history.length, 1);
    const rawMaxCov = Math.max(...history.map((p) => Math.max(p.inventoryCost || 0, p.usedCost || 0)), 0);
    const stepC = niceStep(Math.max(rawMaxCov, 1) * 1.15);
    const maxV = niceCeil(Math.max(rawMaxCov, 1) * 1.15, stepC);
    const coverage = history.map((p) => (p.usedCost ? (p.inventoryCost / (p.usedCost / 7)) : 0));
    const maxDays = niceCeil(Math.max(...coverage, 1) * 1.2, 5);
    const xAt = (i) => L + ((i + 0.5) * plotW) / n;
    const yAt = (v) => B - ((v || 0) / maxV) * plotH;
    const yDays = (v) => B - ((v || 0) / maxDays) * plotH;
    const ticksLeft = [];
    for (let v = 0; v <= maxV; v += stepC) ticksLeft.push(v);
    const grid = ticksLeft.map((v) =>
      `<line x1="${L}" y1="${yAt(v)}" x2="${R}" y2="${yAt(v)}" stroke="#e6e6e6"/>` +
      `<text x="${L - 5}" y="${yAt(v) + 3}" text-anchor="end" class="ax">${v ? fmtK(v) : "0"}</text>`).join("");
    const ticksRight = [];
    for (let v = 0; v <= maxDays; v += 5) ticksRight.push(v);
    const rightAxis = ticksRight.map((v) =>
      `<text x="${R + 6}" y="${yDays(v) + 3}" class="ax">${Math.round(v)}</text>`).join("");
    // Barras del par pegadas (sin aire al medio) y ocupando el grueso del
    // espacio de su semana, como la referencia del equipo.
    const slotW = plotW / n;
    const pairBarW = Math.min(slotW * 0.42, 34);
    const bars = history.map((p, i) => {
      const x = xAt(i);
      const yu = yAt(p.usedCost); const yi = yAt(p.inventoryCost);
      const rot = (bx, by, text) =>
        `<text x="${bx}" y="${by}" class="rotlab" transform="rotate(-90 ${bx} ${by})">${text}</text>`;
      return (p.usedCost ? `<rect x="${x - pairBarW}" y="${yu}" width="${pairBarW}" height="${Math.max(2, B - yu)}" fill="${NAVY}"/>` : "") +
        (p.inventoryCost ? `<rect x="${x}" y="${yi}" width="${pairBarW}" height="${Math.max(2, B - yi)}" fill="${GREEN}"/>` : "") +
        (p.usedCost && B - yu > 40 ? rot(x - pairBarW / 2 + 4, B - 6, fmtK(p.usedCost)) : "") +
        (p.inventoryCost && B - yi > 40 ? rot(x + pairBarW / 2 + 4, B - 6, fmtK(p.inventoryCost)) : "");
    }).join("");
    const covered = history.map((p, i) => ({ i, days: coverage[i] })).filter((item) => item.days > 0);
    const linePts = covered.map((item) => `${xAt(item.i)},${yDays(item.days)}`).join(" ");
    const chips = covered.map((item) => {
      const x = xAt(item.i); const y = Math.max(T + 12, yDays(item.days) - 16);
      return `<rect x="${x - 32}" y="${y - 10}" width="64" height="18" rx="2" fill="${TEAL}"/>` +
        `<text x="${x}" y="${y + 3}" text-anchor="middle" class="chipteal">${Math.round(item.days)} días</text>`;
    }).join("");
    const covEmptyNote = rawMaxCov
      ? ""
      : `<text x="${(L + R) / 2}" y="${(T + B) / 2}" text-anchor="middle" class="leg">Sin datos de inventario para las semanas consultadas.</text>`;
    const xLabels = history.map((p, i) =>
      `<text x="${xAt(i)}" y="${B + 13}" text-anchor="middle" class="ax">${ddmmyyyy(p.endsAt) || escapeHtml(p.label)}</text>`).join("");
    const legendY = H - 8;
    return `<svg class="bv-svg" viewBox="0 0 ${W} ${H}">
      <style>.ax{font:10.5px Calibri,Arial;fill:#808080}.rotlab{font:700 11px Calibri,Arial;fill:#fff}.chipteal{font:700 11px Calibri,Arial;fill:#fff}.leg{font:11px Calibri,Arial;fill:${GRAY_TXT}}</style>
      ${grid}${rightAxis}${bars}${covEmptyNote}
      ${covered.length > 1 ? `<polyline points="${linePts}" fill="none" stroke="${TEAL}" stroke-width="2.2"/>` : ""}
      ${chips}${xLabels}
      <line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="#bfbfbf"/>
      <rect x="14" y="${legendY - 8}" width="9" height="9" fill="${NAVY}"/><text x="26" y="${legendY}" class="leg">Consumo $</text>
      <rect x="88" y="${legendY - 8}" width="9" height="9" fill="${GREEN}"/><text x="100" y="${legendY}" class="leg">Inventario $</text>
      <line x1="164" y1="${legendY - 4}" x2="180" y2="${legendY - 4}" stroke="${TEAL}" stroke-width="2.2"/><text x="184" y="${legendY}" class="leg">Cobertura de Inv en días de ventas</text>
    </svg>`;
  }

  // ---- Pagina 2: Compra realizada vs sugerida por familia ----
  function familyPurchaseSvg() {
    const W = 340; const H = 500;
    const L = 92; const R = 318; const T = 24; const B = 452;
    const plotW = R - L; const plotH = B - T;
    const nonZeroRows = familyPurchaseRows.filter((r) => r.purchased || r.suggested);
    const rows = nonZeroRows.length ? nonZeroRows : familyPurchaseRows.slice(0, 6);
    const rawMaxFam = Math.max(...rows.map((r) => Math.max(r.purchased, r.suggested)), 0);
    const stepF = niceStep(Math.max(rawMaxFam, 1) * 1.25);
    const maxV = niceCeil(Math.max(rawMaxFam, 1) * 1.25, stepF);
    const xAt = (v) => L + ((v || 0) / maxV) * plotW;
    const ticks = [];
    for (let v = 0; v <= maxV; v += stepF) ticks.push(v);
    const grid = ticks.map((v) =>
      `<line x1="${xAt(v)}" y1="${T}" x2="${xAt(v)}" y2="${B}" stroke="#e9e9e9"/>` +
      `<text x="${xAt(v)}" y="${B + 12}" text-anchor="middle" class="ax">${v ? fmtK(v) : "0"}</text>`).join("");
    const famEmptyNote = rawMaxFam
      ? ""
      : `<text x="${(L + R) / 2}" y="${(T + B) / 2}" text-anchor="middle" class="leg">Sin datos de compra por familia para este periodo.</text>`;
    const groupH = plotH / rows.length;
    // Barras del par pegadas (sin aire al medio) y gruesas; la LONGITUD sigue
    // siendo la unica codificacion del valor: la cifra va fuera de la barra
    // (o dentro solo si cabe). Los ceros se marcan explicitos.
    const pairBarH = Math.min(groupH * 0.42, 26);
    const bars = rows.map((row, i) => {
      const yc = T + (i + 0.5) * groupH;
      const bar = (v, y, color) => {
        if (!v) {
          return `<text x="${L + 5}" y="${y + pairBarH / 2 + 3.5}" class="vzero">0</text>`;
        }
        const bw = Math.max(2, xAt(v) - L);
        const fitsInside = bw > 58;
        const textX = fitsInside ? L + bw - 5 : L + bw + 5;
        return `<rect x="${L}" y="${y}" width="${bw}" height="${pairBarH}" fill="${color}"/>` +
          `<text x="${textX}" y="${y + pairBarH / 2 + 3.5}" text-anchor="${fitsInside ? "end" : "start"}" class="${fitsInside ? "vin" : "vout"}" ${fitsInside ? "" : `fill="${color}"`}>${fmtK(v)}</text>`;
      };
      return `<text x="${L - 6}" y="${yc + 3}" text-anchor="end" class="fam">${escapeHtml(truncateLabel(row.family, 16))}</text>` +
        (rawMaxFam ? bar(row.purchased, yc - pairBarH, NAVY) + bar(row.suggested, yc, GREEN) : "");
    }).join("");
    const legendY = H - 10;
    return `<svg class="bv-svg" viewBox="0 0 ${W} ${H}">
      <style>.ax{font:10.5px Calibri,Arial;fill:#808080}.fam{font:700 12px Calibri,Arial;fill:${GRAY_TXT}}.vin{font:700 11px Calibri,Arial;fill:#fff}.vout{font:700 11px Calibri,Arial}.vzero{font:700 10.5px Calibri,Arial;fill:#b3bdb9}.leg{font:11.5px Calibri,Arial;fill:${GRAY_TXT}}</style>
      ${grid}${bars}${famEmptyNote}
      <rect x="${W / 2 - 112}" y="${legendY - 8}" width="9" height="9" fill="${NAVY}"/><text x="${W / 2 - 100}" y="${legendY}" class="leg">Compra Realizada</text>
      <rect x="${W / 2 + 8}" y="${legendY - 8}" width="9" height="9" fill="${GREEN}"/><text x="${W / 2 + 20}" y="${legendY}" class="leg">Compra Sugerida</text>
    </svg>`;
  }

  // ---- Piezas comunes (logo real de la marca) ----
  const logoSrc = logoDataUri();
  const brandMark = logoSrc ? `<img src="${logoSrc}" width="64" height="64" alt="Sculpture Hospitality"/>` : "";
  const footerLogo = logoSrc ? `<img src="${logoSrc}" width="52" height="52" alt=""/>` : "";
  const pageHeader = `
    <header class="bv-head">
      <div class="bv-mark">
        ${brandMark}
        <div class="bv-brand-text">
          <div class="bv-brand-name">BEVINCO</div>
          <div class="bv-brand-by">by Sculpture Hospitality</div>
        </div>
      </div>
      <div class="bv-title"><h1>${escapeHtml(clientTitle)}</h1><div class="bv-underline"></div></div>
      <div class="bv-period">
        <div class="bv-period-title">Periodo</div>
        <div class="bv-period-row"><span>del:</span><b>${ddmm(payload.period?.startsAt)}</b></div>
        <div class="bv-period-row"><span>al:</span><b>${ddmm(payload.period?.endsAt)}</b></div>
      </div>
    </header>`;
  const pageFooter = `<footer class="bv-foot">${footerLogo}</footer>`;
  const commentBlock = (title, items) => {
    const list = (items || []).length ? items : ["Sin hallazgos relevantes para este periodo."];
    return `<h3 class="bv-ctitle">${escapeHtml(title)}</h3>` +
      list.map((item) => `<div class="bv-citem"><span>&minus;</span><p>${escapeHtml(item)}</p></div>`).join("");
  };
  const kpiBox = (title, value) => `
    <div class="bv-kpi">
      <div class="bv-kpi-head">${escapeHtml(title)}</div>
      <div class="bv-kpi-value">${value}</div>
    </div>`;
  const kpiArrow = `<svg viewBox="0 0 60 96" width="42" height="67" class="bv-arrow" aria-hidden="true">
    <path d="M6 8 C46 16 50 48 32 70" fill="none" stroke="${GREEN}" stroke-width="9" stroke-linecap="round"/>
    <polygon points="46,62 24,88 14,56" fill="${GREEN}"/>
  </svg>`;

  // Diferencia del costo real vs el ideal por periodo: en puntos porcentuales
  // y en pesos (cuanto dinero representa esa desviacion sobre los ingresos).
  // Con mas de un periodo se agrega la fila Total (pedido de Pedro): suma de
  // ingresos y costos, con los porcentajes ponderados por los ingresos.
  const costDiffPeriods = history.filter((item) => item.revenue && item.costPercent);
  const diffCell = (item) => {
    const hasIdeal = (item.idealCostPercent || 0) > 0;
    const diffPp = hasIdeal ? (item.costPercent || 0) - (item.idealCostPercent || 0) : 0;
    const diffAmount = hasIdeal ? Math.round(((item.revenue || 0) * diffPp) / 100) : 0;
    return { hasIdeal, diffPp, diffAmount, over: hasIdeal && diffAmount > 0 };
  };
  const costDiffRows = costDiffPeriods
    .map((item, index) => {
      const { hasIdeal, diffPp, diffAmount, over } = diffCell(item);
      const used = item.usedCost || Math.round(((item.revenue || 0) * (item.costPercent || 0)) / 100);
      return `<tr class="${index % 2 ? "alt" : ""}">
        <td class="tname">${ddmmyyyy(item.endsAt) || escapeHtml(item.label)}</td>
        <td class="tmoney"><span>$</span><span>${fmtMoney(item.revenue)}</span></td>
        <td class="tmoney"><span>$</span><span>${fmtMoney(used)}</span></td>
        <td class="tpct">${fmtPct(item.costPercent)}</td>
        <td class="tpct">${hasIdeal ? fmtPct(item.idealCostPercent) : "-"}</td>
        <td class="tpct ${over ? "neg" : ""}">${hasIdeal ? `${diffPp >= 0 ? "+" : ""}${diffPp.toFixed(1)} pp` : "-"}</td>
        <td class="tmoney ${over ? "neg" : ""}">${hasIdeal ? `<span>$</span><span>${fmtMoney(diffAmount)}</span>` : "<span></span><span>-</span>"}</td>
      </tr>`;
    }).join("");
  let costDiffTotalRow = "";
  if (costDiffPeriods.length > 1) {
    const totalRevenue = costDiffPeriods.reduce((sum, item) => sum + (item.revenue || 0), 0);
    const totalUsed = costDiffPeriods.reduce((sum, item) => sum + (item.usedCost || Math.round(((item.revenue || 0) * (item.costPercent || 0)) / 100)), 0);
    const withIdeal = costDiffPeriods.filter((item) => (item.idealCostPercent || 0) > 0);
    const idealRevenue = withIdeal.reduce((sum, item) => sum + (item.revenue || 0), 0);
    const idealPct = idealRevenue
      ? withIdeal.reduce((sum, item) => sum + (item.revenue || 0) * (item.idealCostPercent || 0), 0) / idealRevenue
      : 0;
    const realPct = totalRevenue ? (totalUsed / totalRevenue) * 100 : 0;
    const totalDiffAmount = withIdeal.reduce((sum, item) => sum + diffCell(item).diffAmount, 0);
    const totalPp = idealRevenue ? (totalDiffAmount / idealRevenue) * 100 : 0;
    const overTotal = idealRevenue > 0 && totalDiffAmount > 0;
    costDiffTotalRow = `<tr class="total">
        <td class="tname">Total</td>
        <td class="tmoney"><span>$</span><span>${fmtMoney(totalRevenue)}</span></td>
        <td class="tmoney"><span>$</span><span>${fmtMoney(totalUsed)}</span></td>
        <td class="tpct">${fmtPct(realPct)}</td>
        <td class="tpct">${idealPct ? fmtPct(idealPct) : "-"}</td>
        <td class="tpct ${overTotal ? "neg" : ""}">${idealRevenue ? `${totalPp >= 0 ? "+" : ""}${totalPp.toFixed(1)} pp` : "-"}</td>
        <td class="tmoney ${overTotal ? "neg" : ""}">${idealRevenue ? `<span>$</span><span>${fmtMoney(totalDiffAmount)}</span>` : "<span></span><span>-</span>"}</td>
      </tr>`;
  }
  const costDiffTable = costDiffRows ? `<table class="bv-table bv-difftable">
      <thead>
        <tr><th colspan="7" class="bv-table-title">Diferencia de costo: real vs ideal</th></tr>
        <tr>
          <th>Periodo</th><th>Ingresos</th><th>Costo usado ($)</th><th>% Costo Real</th><th>% Costo Ideal</th><th>Dif. (pp)</th><th>Dif. de costo ($)</th>
        </tr>
      </thead>
      <tbody>${costDiffRows}${costDiffTotalRow}</tbody>
    </table>` : "";

  // Seccion de eficiencia de stock del reporte mensual: top sin rotacion y
  // dias de cobertura por categoria (foto de la ultima semana del mes).
  const stockEff = payload.stockEfficiency || {};
  const slowRows = (stockEff.slowMovers || []).map((item, index) => `<tr class="${index % 2 ? "alt" : ""}">
      <td class="tname">${escapeHtml(item.name)}</td>
      <td class="tmoney"><span>$</span><span>${fmtMoney(item.stockCost)}</span></td>
    </tr>`).join("");
  const coverageRows = (stockEff.categoryCoverage || []).map((item, index) => `<tr class="${index % 2 ? "alt" : ""}">
      <td class="tname">${escapeHtml(item.category)}</td>
      <td class="tmoney"><span>$</span><span>${fmtMoney(item.stockCost)}</span></td>
      <td class="tpct">${item.coverageDays === null ? "Sin rotación" : `${item.coverageDays} días`}</td>
    </tr>`).join("");
  const stockEfficiencySection = (slowRows || coverageRows) ? `
    <section class="bv-grid2 bv-stockeff">
      <table class="bv-table">
        <thead>
          <tr><th colspan="2" class="bv-table-title">Top 10 sin rotación en el mes</th></tr>
          <tr><th>Producto</th><th>Stock al costo</th></tr>
        </thead>
        <tbody>${slowRows || '<tr><td class="tname" colspan="2">Sin productos detenidos: todo el inventario rotó.</td></tr>'}</tbody>
      </table>
      <table class="bv-table">
        <thead>
          <tr><th colspan="3" class="bv-table-title">Cobertura de inventario por categoría</th></tr>
          <tr><th>Categoría</th><th>Stock al costo</th><th>Cobertura</th></tr>
        </thead>
        <tbody>${coverageRows || '<tr><td class="tname" colspan="3">Sin datos de inventario por categoría.</td></tr>'}</tbody>
      </table>
    </section>` : "";

  const productRows = tableProducts.map((item, index) => {
    const neg = (item.varianceAmount || 0) < 0;
    return `<tr class="${index % 2 ? "alt" : ""}">
      <td class="tname">${escapeHtml(item.name)}</td>
      <td class="tmoney"><span>$</span><span>${item.usedCost ? fmtMoney(item.usedCost) : "-"}</span></td>
      <td class="tmoney ${neg ? "neg" : ""}"><span>$</span><span>${fmtMoney(item.varianceAmount)}</span></td>
      <td class="tpct">${fmtPct(item.variancePercent)}</td>
      <td class="tpct">${item.realCostPercent ? fmtPct(item.realCostPercent) : "-"}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reporte ${escapeHtml(clientTitle)}</title>
  <style>
    @page { margin: 7mm; size: A4 portrait; }
    * { box-sizing: border-box; }
    body { background: #e9edef; color: #333; font-family: Calibri, "Segoe UI", Arial, sans-serif; margin: 0; padding: 16px; }
    .toolbar { display: flex; justify-content: flex-end; margin: 0 auto 12px; max-width: 800px; }
    .toolbar button { background: ${NAVY}; border: 0; border-radius: 6px; color: #fff; cursor: pointer; font-weight: 700; min-height: 38px; padding: 0 16px; }
    .bv-page { background: #fff; margin: 0 auto 16px; max-width: 800px; padding: 12px 20px 8px; }
    .bv-head { align-items: start; display: grid; grid-template-columns: 210px 1fr 150px; margin-bottom: 10px; }
    .bv-mark { align-items: center; display: flex; gap: 10px; }
    .bv-brand-text { line-height: 1.15; }
    .bv-brand-name { color: ${NAVY}; font-size: 17px; font-weight: 700; letter-spacing: 0.6px; }
    .bv-brand-by { color: ${TEAL}; font-size: 10.5px; font-weight: 600; letter-spacing: 0.4px; }
    .bv-title h1 { color: #262626; font-size: 36px; margin: 8px 0 0; text-align: center; }
    .bv-underline { background: ${TEAL}; height: 4px; margin: 6px auto 0; width: 300px; }
    .bv-period { border: 1px solid ${TEAL}; box-shadow: 0 0 0 2px #fff, 0 0 0 3px ${TEAL}; font-size: 13.5px; margin-top: 4px; }
    .bv-period-title { border-bottom: 1px solid ${TEAL}; color: #333; padding: 2px 8px; text-align: center; }
    .bv-period-row { display: flex; justify-content: space-between; padding: 1px 8px; }
    .bv-period-row b { font-weight: 700; }
    .bv-panel { border: 1px solid #d9d9d9; border-radius: 3px; margin-bottom: 10px; padding: 8px 10px; }
    .bv-panel h2 { color: #8c8c8c; font-size: 19px; font-weight: 700; margin: 2px 0 6px; text-align: center; }
    .bv-svg { display: block; height: auto; width: 100%; }
    .bv-row { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) 218px; margin-bottom: 10px; }
    .bv-kpis { display: flex; flex-direction: column; gap: 12px; padding-top: 8px; position: relative; }
    .bv-kpi { border: 2px solid ${NAVY}; }
    .bv-kpi-head { background: ${NAVY}; color: #fff; font-size: 15.5px; font-weight: 700; padding: 4px 6px; text-align: center; }
    .bv-kpi-value { color: #1a1a1a; font-size: 28px; font-weight: 700; padding: 7px 6px; text-align: center; }
    .bv-arrow { position: absolute; right: -14px; top: 146px; }
    .bv-comments { border: 1px solid #d9d9d9; border-radius: 3px; margin-bottom: 10px; padding: 8px 14px; }
    .bv-ctitle { color: #76a73e; font-size: 16px; margin: 6px 0 4px; }
    .bv-citem { display: flex; gap: 10px; margin: 0 0 3px; }
    .bv-citem span { color: #333; }
    .bv-citem p { color: #333; font-size: 13.5px; line-height: 1.4; margin: 0; text-align: justify; }
    .bv-table { border-collapse: separate; border-spacing: 0; table-layout: fixed; width: 100%; }
    .bv-table th.bv-table-title { background: ${TEAL}; border-radius: 8px 8px 0 0; color: #fff; font-size: 15px; font-weight: 700; letter-spacing: 0.3px; padding: 8px 10px; text-align: center; }
    .bv-table th { background: ${NAVY}; color: #fff; font-size: 12px; font-weight: 700; letter-spacing: 0.2px; padding: 7px 10px; vertical-align: middle; }
    .bv-table th:first-child { text-align: left; }
    .bv-table th:not(:first-child) { text-align: right; }
    .bv-table td { border-bottom: 1px solid #e3ebe8; color: #2b3a36; font-size: 12.5px; padding: 7px 10px; vertical-align: middle; }
    .bv-table tbody tr:last-child td { border-bottom: 0; }
    .bv-table tr.alt td { background: #f5f9f8; }
    .bv-table .tname { width: 32%; }
    .bv-difftable { margin-top: 8px; }
    .bv-difftable .tname { width: 15%; }
    .bv-difftable tr.total td { background: #eef4f1; border-top: 2px solid ${NAVY}; font-weight: 700; }
    .bv-stockeff { align-items: start; margin-top: 10px; }
    .tmoney { text-align: right; white-space: nowrap; width: 18%; }
    .tmoney span:first-child { color: #9ab0aa; margin-right: 3px; }
    .tmoney.neg span:last-child { color: #d23f31; font-weight: 700; }
    .tpct { text-align: right; width: 16%; }
    .tpct.neg { color: #d23f31; font-weight: 700; }
    .bv-foot { display: flex; justify-content: center; margin-top: 10px; }
    .bv-grid2 { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; margin-bottom: 10px; }
    .bv-col { display: flex; flex-direction: column; gap: 10px; }
    .bv-col .bv-panel { margin-bottom: 0; }
    .page-break { break-before: page; page-break-before: always; }
    @media print {
      body { background: #fff; padding: 0; }
      .toolbar { display: none; }
      .bv-page { margin: 0; max-width: none; padding: 0; }
      .bv-panel { break-inside: avoid; }
      /* Los comentarios pueden fluir entre paginas (cada punto entero),
         asi la pagina 1 no queda con un vacio cuando el bloque es largo. */
      .bv-comments { break-inside: auto; }
      .bv-citem { break-inside: avoid; }
      .bv-ctitle { break-after: avoid; }
      .bv-table { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Guardar como PDF</button></div>

  <main class="bv-page">
    ${pageHeader}
    <section class="bv-panel">
      <h2>Costo real vs Costo Ideal</h2>
      ${costComboSvg()}
      ${isMonthlyReport ? costDiffTable : ""}
    </section>
    <section class="bv-row">
      <div class="bv-panel">
        <h2>Ahorro/faltantes inventario ($)</h2>
        ${familyVarianceSvg()}
      </div>
      <aside class="bv-kpis">
        ${kpiBox("Suma de ahorros", `$${fmtMoney(savings)}`)}
        ${kpiBox("Suma de faltantes", `$${fmtMoney(shortages)}`)}
        ${kpiBox("Merma reportada al $", waste ? `-$${fmtMoney(waste)}` : "$0")}
        ${kpiArrow}
      </aside>
    </section>
    <section class="bv-comments">
      ${commentBlock("Lo mejor de la semana:", analysis.bestOfWeek)}
      ${commentBlock("Los desafíos de la semana:", analysis.weeklyChallenges)}
    </section>
    <table class="bv-table">
      <thead>
        <tr><th colspan="5" class="bv-table-title">Desempeño de los 10 productos con mayor uso ($)</th></tr>
        <tr>
          <th>Productos</th><th>Usado (Costo)</th><th>Ahorro / Faltante al costo</th><th>% de Ahorro / Faltante</th><th>Costo Real</th>
        </tr>
      </thead>
      <tbody>${productRows}</tbody>
    </table>
    ${pageFooter}
  </main>

  <main class="bv-page page-break">
    ${pageHeader}
    ${isMonthlyReport ? `
    <section class="bv-grid2">
      <div class="bv-panel">
        <h2>Compra Realizada vs Sugerida</h2>
        ${purchaseAreaSvg()}
      </div>
      <div class="bv-panel">
        <h2>Cobertura de inventario</h2>
        ${coverageSvg()}
      </div>
    </section>` : `
    <section class="bv-grid2">
      <div class="bv-col">
        <div class="bv-panel">
          <h2>Compra Realizada vs Sugerida</h2>
          ${purchaseAreaSvg()}
        </div>
        <div class="bv-panel">
          <h2>Cobertura de inventario</h2>
          ${coverageSvg()}
        </div>
      </div>
      <div class="bv-panel">
        <h2>Compra Realizada vs Sugerida por familia</h2>
        ${familyPurchaseSvg()}
      </div>
    </section>`}
    ${isMonthlyReport ? stockEfficiencySection : ""}
    <section class="bv-comments">
      ${commentBlock("Eficiencia de stock y compra:", analysis.stockEfficiency)}
    </section>
    ${pageFooter}
  </main>
</body>
</html>`;
}

app.get("/api/system/backup-status", requireAuth, (_request, response) => {
  response.json(supabaseStatus);
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/auth/me", (request, response) => {
  const session = readSession(request);
  response.json({
    authenticated: Boolean(session),
    user: session ? {
      id: session.id,
      username: session.username,
      name: session.name || session.username,
      email: session.email || "",
      role: session.role || "Superadmin",
      permissions: session.permissions || [],
    } : null,
  });
});

app.post("/api/auth/login", async (request, response) => {
  if (!authUsername || !authPassword) {
    response.status(503).json({ error: "CMS login is not configured." });
    return;
  }

  const { username, password } = request.body || {};

  if ((timingSafeEqual(username, authUsername) || timingSafeEqual(String(username || "").toLowerCase(), cmsSuperadminEmail)) && timingSafeEqual(password, authPassword)) {
    const envUser = {
      id: "env-superadmin",
      username: cmsSuperadminEmail,
      name: "Gerencia Bevinco",
      email: cmsSuperadminEmail,
      role: "Superadmin",
      permissions: ["dashboard", "module1", "tasks", "reports", "criteria", "users"],
    };
    response.setHeader("Set-Cookie", sessionCookie(createSessionToken(envUser)));
    response.json({ authenticated: true, user: envUser });
    return;
  }

  const store = await readStore();
  const user = (store.users || []).find((candidate) => {
    const login = String(username || "").toLowerCase();
    return [candidate.email, candidate.username, candidate.name].filter(Boolean).some((value) => String(value).toLowerCase() === login);
  });

  if (!user || !verifyPassword(password, user.passwordHash)) {
    response.status(401).json({ error: "Usuario o contrasena incorrectos." });
    return;
  }

  const sessionUser = sessionUserPayload(user);
  response.setHeader("Set-Cookie", sessionCookie(createSessionToken(sessionUser)));
  response.json({ authenticated: true, user: sessionUser });
});

app.post("/api/auth/logout", (_request, response) => {
  response.setHeader("Set-Cookie", clearSessionCookie());
  response.json({ authenticated: false });
});

const validPresence = ["disponible", "ausente", "ocupado", "no-molestar"];

app.post("/api/presence", requireAuth, async (request, response) => {
  const presence = String(request.body?.presence || "");
  if (!validPresence.includes(presence)) {
    response.status(400).json({ error: "Estado inválido." });
    return;
  }
  const key = String(request.session.email || request.session.username || "").toLowerCase();
  if (key) {
    const store = await readStore();
    store.presence[key] = presence;
    await writeStore(store);
  }
  response.json({ presence });
});

app.get("/api/users", requireAuth, requirePermission("users"), async (_request, response) => {
  const store = await readStore();
  response.json({
    users: [
      {
        id: "env-superadmin",
        name: "Gerencia Bevinco",
        email: cmsSuperadminEmail,
        role: "Superadmin",
        permissions: ["dashboard", "module1", "tasks", "reports", "criteria", "users"],
        source: "env",
        presence: store.presence[cmsSuperadminEmail] || "disponible",
      },
      ...(store.users || []).map((user) => ({
        ...publicUser(user),
        presence: store.presence[String(user.email || "").toLowerCase()] || "disponible",
      })),
    ],
  });
});

app.post("/api/users", requireAuth, requirePermission("users"), async (request, response) => {
  const store = await readStore();
  const { name, email, password, role = "Usuario", permissions = [] } = request.body || {};

  if (!name || !email || !password || String(password).length < 6) {
    response.status(400).json({ error: "Nombre, email y contraseña de mínimo 6 caracteres son requeridos." });
    return;
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const exists = (store.users || []).some((user) => String(user.email || "").toLowerCase() === normalizedEmail) ||
    timingSafeEqual(normalizedEmail, String(authUsername || "").toLowerCase());
  if (exists) {
    response.status(409).json({ error: "Ya existe un usuario con ese email." });
    return;
  }

  const user = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    email: normalizedEmail,
    role,
    permissions: Array.isArray(permissions) ? permissions : [],
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.users ||= [];
  store.users.unshift(user);
  await writeStore(store);
  response.status(201).json({ user: publicUser(user), users: store.users.map(publicUser) });
});

app.patch("/api/users/:userId", requireAuth, requirePermission("users"), async (request, response) => {
  const store = await readStore();
  const user = (store.users || []).find((candidate) => candidate.id === request.params.userId);

  if (!user) {
    response.status(404).json({ error: "Usuario no encontrado." });
    return;
  }

  const { name, email, password, role, permissions } = request.body || {};
  if (email) {
    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = (store.users || []).some((candidate) => candidate.id !== user.id && String(candidate.email || "").toLowerCase() === normalizedEmail);
    if (exists || timingSafeEqual(normalizedEmail, String(authUsername || "").toLowerCase())) {
      response.status(409).json({ error: "Ya existe un usuario con ese email." });
      return;
    }
    user.email = normalizedEmail;
  }
  if (name) user.name = String(name).trim();
  if (role) user.role = role;
  if (Array.isArray(permissions)) user.permissions = permissions;
  if (password) {
    if (String(password).length < 6) {
      response.status(400).json({ error: "La nueva contrasena debe tener minimo 6 caracteres." });
      return;
    }
    user.passwordHash = hashPassword(password);
  }
  user.updatedAt = new Date().toISOString();
  await writeStore(store);
  response.json({ user: publicUser(user), users: store.users.map(publicUser) });
});

app.delete("/api/users/:userId", requireAuth, requirePermission("users"), async (request, response) => {
  const store = await readStore();
  const before = (store.users || []).length;
  store.users = (store.users || []).filter((user) => user.id !== request.params.userId);

  if (store.users.length === before) {
    response.status(404).json({ error: "Usuario no encontrado." });
    return;
  }

  await writeStore(store);
  response.json({ users: store.users.map(publicUser) });
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
    backupStatus: supabaseStatus,
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

  const requestedClientId = String(request.body?.clientId || "");
  const assignedClient = store.clients.find((client) => client.id === requestedClientId);
  const assignedClientName = assignedClient?.name || String(request.body?.clientName || "");
  const documents = files.map((file) => {
    const text = String(file.text || "").replace(/\0/g, "").trim();
    const name = String(file.name || "criterio.txt").trim();

    return {
      id: `${Date.now()}-${crypto.randomUUID()}`,
      name,
      type: String(file.type || "text/plain"),
      text: text.slice(0, 30000),
      size: Number(file.size || text.length || 0),
      source: String(file.source || request.body?.source || "manual"),
      category: String(file.category || request.body?.category || "criteria"),
      clientId: requestedClientId,
      clientName: assignedClientName,
      uploadedAt: new Date().toISOString(),
    };
  });

  store.criteriaDocuments = [...documents, ...(store.criteriaDocuments || [])].slice(0, 60);
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

app.post("/api/module1/criteria-documents/import-chatgpt", requireAuth, async (request, response) => {
  try {
    const store = await readStore();
    const files = Array.isArray(request.body?.files) ? request.body.files : [];
    const projectName = String(request.body?.projectName || "Proyecto ChatGPT Bevinco").trim();
    const sections = {
      instrucciones: request.body?.instructions,
      prompt_reporte_semanal: request.body?.reportPrompt,
      ejemplos_comentarios: request.body?.examples,
      notas_reglas_cuestionario: request.body?.notes,
    };
    const aiImport = await generateChatGptCriteriaDocuments({ projectName, sections, files });
    const assignedClient = store.clients.find((client) => client.id === String(request.body?.clientId || ""));

    const documents = aiImport.documents.map((document) => {
      const text = String(document.text || "").replace(/\0/g, "").trim();

      return {
        id: `${Date.now()}-${crypto.randomUUID()}`,
        name: `ChatGPT - ${projectName} - ${document.name}`.slice(0, 180),
        type: "text/markdown",
        text: text.slice(0, 30000),
        size: text.length,
        source: "chatgpt-api",
        category: document.category,
        clientId: assignedClient?.id || "",
        clientName: assignedClient?.name || "",
        uploadedAt: new Date().toISOString(),
      };
    });

    store.criteriaDocuments = [...documents, ...(store.criteriaDocuments || [])].slice(0, 60);
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
      importSummary: aiImport.summary,
      importedCount: documents.length,
    });
  } catch (error) {
    response.status(error.status || 500).json({ error: error.message || "No se pudo importar contenido desde ChatGPT con OpenAI." });
  }
});

// Editar un criterio existente desde el CMS (nombre, cliente, contenido).
// Al cambiar el conocimiento se invalidan los analisis generados para que la
// proxima redaccion use la version nueva.
app.patch("/api/module1/criteria-documents/:documentId", requireAuth, async (request, response) => {
  const store = await readStore();
  const document = (store.criteriaDocuments || []).find((item) => item.id === request.params.documentId);
  if (!document) {
    response.status(404).json({ error: "No se encontró el criterio." });
    return;
  }

  if (typeof request.body?.name === "string" && request.body.name.trim()) document.name = request.body.name.trim().slice(0, 160);
  if (typeof request.body?.category === "string") document.category = request.body.category.trim().slice(0, 60) || document.category;
  if (typeof request.body?.text === "string") {
    document.text = request.body.text.replace(/\0/g, "").trim().slice(0, 30000);
    document.size = document.text.length;
  }
  if (typeof request.body?.clientId === "string") {
    document.clientId = request.body.clientId;
    const assigned = store.clients.find((client) => client.id === request.body.clientId);
    document.clientName = assigned?.name || String(request.body?.clientName || "").trim();
  }
  document.updatedAt = new Date().toISOString();

  store.reports.forEach((report) => { report.analysis = null; });
  await writeStore(store);
  response.json({ document, criteriaDocuments: store.criteriaDocuments });
});

// Actualizacion MASIVA: aplica un bloque nombrado a muchos criterios de una
// vez. Si el documento ya tiene un bloque con ese titulo, se reemplaza su
// contenido (re-aplicable sin duplicar); si no, se agrega al final.
app.post("/api/module1/criteria-documents/bulk-block", requireAuth, async (request, response) => {
  const store = await readStore();
  const title = String(request.body?.title || "").trim().slice(0, 80);
  const text = String(request.body?.text || "").replace(/\0/g, "").trim().slice(0, 12000);
  const target = String(request.body?.target || "all"); // all | general | client
  const clientId = String(request.body?.clientId || "");

  if (!title || !text) {
    response.status(400).json({ error: "El bloque necesita un título y un contenido." });
    return;
  }

  const matches = (store.criteriaDocuments || []).filter((document) => {
    if (target === "general") return !document.clientId;
    if (target === "client") return document.clientId === clientId;
    return true;
  });
  if (!matches.length) {
    response.status(400).json({ error: "Ningún criterio coincide con el destino elegido." });
    return;
  }

  const startMarker = `<<BLOQUE: ${title}>>`;
  const endMarker = "<<FIN BLOQUE>>";
  const block = `${startMarker}\n${text}\n${endMarker}`;

  let updated = 0;
  for (const document of matches) {
    const current = String(document.text || "");
    const startIndex = current.indexOf(startMarker);
    let next;
    if (startIndex >= 0) {
      const endIndex = current.indexOf(endMarker, startIndex);
      const tail = endIndex >= 0 ? current.slice(endIndex + endMarker.length) : "";
      next = current.slice(0, startIndex) + block + tail;
    } else {
      next = `${current.trim()}\n\n${block}`;
    }
    document.text = next.slice(0, 30000);
    document.size = document.text.length;
    document.updatedAt = new Date().toISOString();
    updated += 1;
  }

  store.reports.forEach((report) => { report.analysis = null; });
  await writeStore(store);
  response.json({ updated, criteriaDocuments: store.criteriaDocuments });
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

app.delete("/api/module1/clients/:clientId", requireAuth, async (request, response) => {
  const store = await readStore();
  const { clientId } = request.params;
  const client = store.clients.find((candidate) => candidate.id === clientId);

  if (!client) {
    response.status(404).json({ error: "No se encontró el restaurante/local indicado." });
    return;
  }

  const removedReports = store.reports.filter((report) => report.clientId === clientId).length;
  store.clients = store.clients.filter((candidate) => candidate.id !== clientId);
  store.reports = store.reports.filter((report) => report.clientId !== clientId);
  await writeStore(store);

  response.json({
    removedClientId: clientId,
    removedReports,
    clients: store.clients,
    reports: store.reports.map((item) => buildReportPayload(store, item)),
  });
});

function sculptureUnitKey(unit = {}) {
  return `${unit.sculptureCid || unit.cid || ""}-${unit.area || ""}`.toLowerCase();
}

app.get("/api/module1/sculpture-units", requireAuth, async (_request, response) => {
  try {
    const payload = await discoverSculptureUnits();
    const store = await readStore();
    const hidden = new Set(store.hiddenSculptureUnits || []);
    response.json({
      ...payload,
      units: (payload.units || []).map((unit) => ({ ...unit, hidden: hidden.has(sculptureUnitKey(unit)) })),
    });
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "Unable to discover Sculpture units.",
      details: error.details,
    });
  }
});

app.get("/api/module1/sculpture-units/periods", requireAuth, async (request, response) => {
  const cid = configuredIdentifier(request.query.cid);
  if (!cid) {
    response.status(400).json({ error: "Falta el identificador del restaurante." });
    return;
  }
  const baseUrl = String(request.query.baseUrl || "") || baseUrlForSculptureArea(String(request.query.area || ""));

  try {
    const periods = await fetchSculpturePeriodsForClient({ baseUrl, cid });
    response.json({ periods });
  } catch (error) {
    console.error("[periods] activation failed:", error.status, error.message, String(error.details || "").slice(0, 300));
    response.status(error.status || 500).json({
      error: "No se pudieron traer los periodos de este restaurante.",
      details: error.message,
    });
  }
});

app.post("/api/module1/sculpture-units/visibility", requireAuth, async (request, response) => {
  const { sculptureCid, cid, area, hidden } = request.body || {};
  const key = sculptureUnitKey({ sculptureCid: sculptureCid || cid, area });

  if (!key || key === "-") {
    response.status(400).json({ error: "Falta el restaurante a ocultar o restaurar." });
    return;
  }

  const store = await readStore();
  const current = new Set(store.hiddenSculptureUnits || []);
  if (hidden) current.add(key);
  else current.delete(key);
  store.hiddenSculptureUnits = [...current];
  await writeStore(store);

  response.json({ hiddenSculptureUnits: store.hiddenSculptureUnits });
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
  const { unit, clientId, periodId, fromMonth, toMonth, periodIds = [], periods: incomingPeriods = [] } = request.body || {};
  const resolvedUnit = unit || store.clients.find((candidate) => candidate.id === clientId);

  if (!resolvedUnit) {
    response.status(400).json({ error: "Selecciona un restaurante/local de Sculpture para consultar." });
    return;
  }

  const sculptureCid = configuredIdentifier(resolvedUnit.sculptureCid, resolvedUnit.cid);
  if (!sculptureCid) {
    response.status(400).json({ error: "El restaurante/local seleccionado no tiene CID numérico de Sculpture." });
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
  let selectedPeriods = resolvePeriodsForSculptureQuery(store, {
    periods: sculptureClientPeriods.length ? sculptureClientPeriods : incomingPeriods,
    periodId,
    fromMonth,
    toMonth,
    // Sin el cid, belongsToClient() queda inerte y un periodId de otro
    // restaurante vuelve a ganar.
    cid: sculptureCid,
  });

  // Si el usuario eligio periodos semanales puntuales, respetamos esa seleccion.
  const requestedPeriodIds = Array.isArray(periodIds) ? periodIds.filter(Boolean) : [];
  if (requestedPeriodIds.length) {
    const poolPeriods = (sculptureClientPeriods.length ? sculptureClientPeriods : incomingPeriods)
      .map((period) => ensurePeriod(store, period))
      .filter(Boolean);
    // El filtro de la linea siguiente matchea por pid CRUDO, que no es unico.
    // Si poolPeriods queda vacio, un pid "41" matchea de golpe los periodos 41
    // de los 20 cid del store: la misma fuga por otra puerta.
    const pool = poolPeriods.length
      ? poolPeriods
      : store.periods.filter((period) => !/^sculpture-\d+-/.test(period.id) || period.id.startsWith(`sculpture-${sculptureCid}-`));
    const matched = pool.filter((period) => requestedPeriodIds.includes(period.id) || requestedPeriodIds.includes(period.pid) || requestedPeriodIds.includes(period.sculpturePid));
    if (matched.length) selectedPeriods = matched;
  }

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
    report.backfill = false;
    syncResultsByPeriod[period.id] = syncResults;
    queriedReports.push(buildReportPayload(store, report));
  }

  // Si se uso el periodo por defecto (el mas reciente) y vino sin ventas, es
  // el periodo ABIERTO de la semana en curso: se cae automaticamente al
  // periodo cerrado anterior (hasta 3 intentos).
  const usedDefaultPeriod = !requestedPeriodIds.length && !fromMonth && !toMonth && !periodId;
  if (usedDefaultPeriod && queriedReports.length === 1 && !(queriedReports[0].summary?.revenue > 0) && sculptureClientPeriods.length) {
    const orderedAll = [...sculptureClientPeriods].sort((left, right) =>
      String(right.startsAt || right.label).localeCompare(String(left.startsAt || left.label)),
    );
    const startIndex = orderedAll.findIndex((period) => period.id === selectedPeriods[0].id);
    for (const candidate of orderedAll.slice(startIndex + 1, startIndex + 4)) {
      const period = ensurePeriod(store, candidate);
      if (!period) continue;
      const stored = store.reports.find(
        (item) => item.clientId === client.id && item.periodId === period.id,
      );
      const storedComplete = stored?.summary?.revenue > 0 && stored?.summary?.usedCost > 0 && (stored?.topUsageProducts || []).length;
      if (storedComplete) {
        stored.backfill = false;
        selectedPeriods.length = 0;
        selectedPeriods.push(period);
        queriedReports.length = 0;
        queriedReports.push(buildReportPayload(store, stored));
        break;
      }
      const report = reportForClientPeriod(store, client.id, period.id);
      let syncResults;
      try {
        syncResults = await syncSculptureSources(store, report, {
          cid: sculptureCid,
          pid: period.sculpturePid || period.pid,
          area: client.area,
        });
      } catch {
        continue;
      }
      if (report.summary?.revenue > 0) {
        report.backfill = false;
        selectedPeriods.length = 0;
        selectedPeriods.push(period);
        queriedReports.length = 0;
        queriedReports.push(buildReportPayload(store, report));
        syncResultsByPeriod[period.id] = syncResults;
        break;
      }
    }
  }

  // El grafico historico compara las ultimas 4 semanas con datos REALES: si
  // las 3 semanas previas al periodo consultado aun no estan sincronizadas,
  // se traen aqui (una sola vez; despues quedan guardadas).
  if (sculptureClientPeriods.length && selectedPeriods.length) {
    const orderedPeriods = [...sculptureClientPeriods].sort((left, right) =>
      String(right.startsAt || right.label).localeCompare(String(left.startsAt || left.label)),
    );
    const oldestSelected = [...selectedPeriods].sort((left, right) =>
      String(left.startsAt || left.label).localeCompare(String(right.startsAt || right.label)),
    )[0];
    const selectedIndex = orderedPeriods.findIndex((period) => period.id === oldestSelected.id);
    const previousPeriods = selectedIndex >= 0 ? orderedPeriods.slice(selectedIndex + 1, selectedIndex + 4) : [];

    for (const rawPeriod of previousPeriods) {
      const period = ensurePeriod(store, rawPeriod);
      if (!period) continue;
      const existing = store.reports.find(
        (candidate) => candidate.clientId === client.id && candidate.periodId === period.id,
      );
      if (existing?.summary?.revenue) continue;

      try {
        const report = reportForClientPeriod(store, client.id, period.id);
        await syncSculptureSources(store, report, {
          cid: sculptureCid,
          pid: period.sculpturePid || period.pid,
          area: client.area,
        });
        // Semana traida solo para el grafico historico: no aparece en la
        // bandeja salvo que el usuario la genere explicitamente.
        if (report.backfill !== false) report.backfill = true;
      } catch {
        // La semana previa es opcional: si falla, el grafico la omite.
      }
    }
  }

  await writeStore(store);

  // Reconstruir los payloads: el historial de 4 semanas debe reflejar las
  // semanas previas recien sincronizadas.
  const refreshedReports = queriedReports.map((payload) => {
    const stored = store.reports.find((item) => item.id === payload.id);
    return stored ? buildReportPayload(store, stored) : payload;
  });

  const accumulatedReport = accumulateReportPayloads(refreshedReports);

  response.json({
    client,
    clients: store.clients,
    periods: store.periods,
    selectedReport: refreshedReports[0] || null,
    queriedReports: refreshedReports,
    accumulatedReport,
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
    response.status(404).json({ error: "No se encontró el reporte." });
    return;
  }

  const allowedFields = ["status", "workflowState", "comments", "emailDraft", "analysis", "summary", "categoryVariances", "topProducts", "purchaseSuggestions"];
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(request.body, field)) {
      report[field] = request.body[field];
    }
  });

  report.updatedAt = new Date().toISOString();
  await writeStore(store);
  response.json(buildReportPayload(store, report));
});

const MONTH_NAMES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// Reporte MENSUAL: acumula los periodos semanales seleccionados de un mes.
// Regla del equipo: ingresos/ventas/compras se SUMAN; existencias/stock y
// sugerencia de compra se toman del ULTIMO periodo. El resultado se guarda
// como un reporte real (Historial, PDF, analisis IA y chat funcionan igual).
app.post("/api/module1/monthly/generate", requireAuth, async (request, response) => {
  const store = await readStore();
  const { unit, clientId, month, periodIds = [] } = request.body || {};
  const resolvedUnit = unit || store.clients.find((candidate) => candidate.id === clientId);

  if (!resolvedUnit) {
    response.status(400).json({ error: "Selecciona un restaurante para el reporte mensual." });
    return;
  }
  const monthKey = String(month || "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    response.status(400).json({ error: "Selecciona el mes del reporte." });
    return;
  }

  const sculptureCid = configuredIdentifier(resolvedUnit.sculptureCid, resolvedUnit.cid);
  if (!sculptureCid) {
    response.status(400).json({ error: "El restaurante seleccionado no tiene CID numérico de Sculpture." });
    return;
  }

  const client = ensureClient(store, {
    ...resolvedUnit,
    cid: sculptureCid,
    sculptureCid,
    sculptureBaseUrl: resolvedUnit.baseUrl || resolvedUnit.sculptureBaseUrl || baseUrlForSculptureArea(resolvedUnit.area),
    recipients: resolvedUnit.recipients || [],
  });

  let clientPeriods = [];
  try {
    clientPeriods = await fetchSculpturePeriodsForClient({
      baseUrl: client.sculptureBaseUrl || baseUrlForSculptureArea(client.area),
      cid: sculptureCid,
    });
  } catch {
    clientPeriods = [];
  }

  const requestedIds = Array.isArray(periodIds) ? periodIds.filter(Boolean) : [];
  const monthPeriods = clientPeriods.filter((period) => periodMonthKey(period) === monthKey);
  // Con seleccion explicita se aceptan semanas de meses vecinos: el "mes
  // contable" del cliente puede cruzar el mes calendario.
  const chosen = requestedIds.length
    ? clientPeriods.filter((period) => requestedIds.includes(period.id))
    : monthPeriods;

  if (!chosen.length) {
    response.status(400).json({ error: "No hay periodos semanales de ese mes para acumular." });
    return;
  }

  const payloads = [];
  for (const rawPeriod of [...chosen].sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))) {
    const period = ensurePeriod(store, rawPeriod);
    if (!period) continue;
    const weekly = reportForClientPeriod(store, client.id, period.id);
    if (!(weekly.summary?.revenue > 0)) {
      try {
        await syncSculptureSources(store, weekly, {
          cid: sculptureCid,
          pid: period.sculpturePid || period.pid,
          area: client.area,
        });
      } catch {
        // Semana sin datos: se omite del acumulado.
      }
      if (weekly.backfill !== false) weekly.backfill = true;
    }
    if (weekly.summary?.revenue > 0) payloads.push(buildReportPayload(store, weekly));
  }

  if (!payloads.length) {
    response.status(400).json({ error: "Ninguna semana de ese mes tiene datos de auditoría cerrados." });
    return;
  }

  const accumulated = accumulateReportPayloads(payloads);
  const [yearText, monthNumber] = monthKey.split("-");
  const monthLabel = `${MONTH_NAMES_ES[Number(monthNumber) - 1]} ${yearText}`;

  const syntheticPeriod = ensurePeriod(store, {
    id: `mensual-${monthKey}`,
    label: `Mes de ${monthLabel}`,
    startsAt: accumulated.period.startsAt,
    endsAt: accumulated.period.endsAt,
    source: "mensual",
  });

  const reportId = `mensual-${client.id}-${monthKey}`;
  let report = store.reports.find((candidate) => candidate.id === reportId);
  if (!report) {
    report = { id: reportId, clientId: client.id, comments: "", emailDraft: "", chat: [] };
    store.reports.push(report);
  }

  Object.assign(report, {
    clientId: client.id,
    periodId: syntheticPeriod?.id || `mensual-${monthKey}`,
    status: report.status || "Borrador",
    monthly: true,
    backfill: false,
    summary: accumulated.summary,
    categoryVariances: accumulated.categoryVariances,
    topProducts: accumulated.topProducts,
    topUsageProducts: accumulated.topUsageProducts,
    familyVariances: accumulated.familyVariances,
    familyPurchases: accumulated.familyPurchases,
    familySuggested: accumulated.familySuggested,
    purchaseSuggestions: accumulated.purchaseSuggestions,
    monthlyHistory: accumulated.monthlyHistory,
    stockEfficiency: accumulated.stockEfficiency,
    includedPeriods: accumulated.includedPeriods,
    sourceStatus: accumulated.sourceStatus,
    analysis: null,
    updatedAt: new Date().toISOString(),
  });

  await writeStore(store);

  response.json({
    report: buildReportPayload(store, report),
    weeksIncluded: accumulated.includedPeriods,
    reports: store.reports.map((item) => buildReportPayload(store, item)),
  });
});

// Chat conversacional sobre un reporte: mismo contexto que el analisis con IA
// (metodo Bevinco + skill del cliente + datos de la semana + analisis actual),
// con historial persistido en el reporte. Ida y vuelta estilo ChatGPT.
app.post("/api/module1/reports/:reportId/chat", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).json({ error: "No se encontró el reporte." });
    return;
  }
  if (!openaiApiKey) {
    response.status(503).json({ error: "La IA no está configurada en el servidor (falta OPENAI_API_KEY)." });
    return;
  }

  const message = String(request.body?.message || "").trim().slice(0, 4000);
  const images = (Array.isArray(request.body?.images) ? request.body.images : [])
    .filter((item) => /^data:image\/(png|jpe?g|webp);base64,/.test(String(item?.dataUrl || "")))
    .slice(0, 4);
  const texts = (Array.isArray(request.body?.texts) ? request.body.texts : []).slice(0, 4);
  if (!message && !images.length && !texts.length) {
    response.status(400).json({ error: "Escribe un mensaje para el agente." });
    return;
  }

  const payload = buildReportPayload(store, report);
  const clientName = payload.client?.name || report.clientId;
  const criteria = criteriaForClient(payload.criteriaDocuments || [], clientName, payload.client?.id || payload.clientId || "", payload.allClientNames || [])
    .map((document) => ({
      nombre: document.name,
      contenido: String(document.text || "").trim().slice(0, 6000),
    }));

  const summary = payload.summary || {};
  const contextText = [
    "Eres el asistente conversacional de este reporte. Responde SIEMPRE en español, breve, técnico y accionable.",
    "",
    "JERARQUÍA DE OBEDIENCIA (en este orden, sin excepciones):",
    "1. LA INSTRUCCIÓN DEL EQUIPO EN ESTE CHAT MANDA SIEMPRE, por sobre el método y los criterios. Si piden un formato, tono, orden o contenido específico, cúmplelo al pie de la letra.",
    "2. Si el equipo te pega comentarios o un reporte de ejemplo de lo que ESPERA, tu tarea es CALZAR ese resultado: misma estructura, mismo orden, mismo estilo de redacción, adaptando solo las cifras a los datos reales de este reporte. No lo 'mejores', no reordenes, no agregues secciones que no pidieron.",
    "3. El método Bevinco y los criterios del cliente aplican en todo lo que el equipo no haya pedido distinto.",
    "",
    "Cuando el usuario pida redactar o ajustar comentarios, entrégalos LISTOS para pegar (sin preámbulos como 'aquí tienes').",
    "Usa solo las cifras entregadas; nunca inventes datos.",
    "",
    BEVINCO_ANALYSIS_METHOD,
    "",
    `Criterios del cliente (${clientName}):`,
    criteria.length ? JSON.stringify(criteria) : "Sin criterios específicos; aplica la metodología estándar.",
    "",
    "Datos del reporte:",
    JSON.stringify({
      cliente: clientName,
      periodo: payload.period?.label || report.periodId,
      resumen: {
        ingresos: summary.revenue || 0,
        costoPorcentaje: summary.costPercent || 0,
        costoIdeal: summary.idealCostPercent || 0,
        variancePorcentaje: summary.variancePercent || 0,
        varianceMonto: summary.varianceAmount || 0,
      },
      categorias: (payload.categoryVariances || []).slice(0, 10),
      productos: (payload.topProducts || []).slice(0, 10),
      sugerenciasCompra: (payload.purchaseSuggestions || []).slice(0, 10),
      historico: (payload.history || []).slice(0, 4),
    }),
    "",
    "Análisis/resumen actual del reporte (el usuario puede pedir ajustarlo):",
    String(report.comments || "(aún no generado)").slice(0, 3000),
  ].join("\n");

  const history = Array.isArray(report.chat) ? report.chat.slice(-16) : [];
  // Contenido multimodal: texto + imagenes (vision) + archivos de texto inline.
  let userText = message || "Analiza los archivos adjuntos y complementa el reporte.";
  for (const file of texts) {
    userText += `

[Contenido de ${String(file.name || "archivo").slice(0, 80)}]:
${String(file.content || "").slice(0, 12000)}`;
  }
  const userContent = [{ type: "input_text", text: userText }];
  for (const image of images) {
    userContent.push({ type: "input_image", image_url: image.dataUrl });
  }
  const input = [
    { role: "system", content: contextText },
    ...history.map((item) => ({ role: item.role, content: item.content })),
    { role: "user", content: userContent },
  ];

  try {
    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${openaiApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: openaiChatModel, input, max_output_tokens: 1600 }),
    });
    const aiPayload = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      response.status(502).json({ error: aiPayload?.error?.message || "El agente no pudo responder. Intenta de nuevo." });
      return;
    }
    const reply = extractOpenAiText(aiPayload).trim();
    if (!reply) {
      response.status(502).json({ error: "El agente devolvió una respuesta vacía. Intenta de nuevo." });
      return;
    }

    const attachmentNote = [...images, ...texts].map((item) => `📎 ${String(item.name || "adjunto").slice(0, 60)}`).join("  ");
    const storedMessage = [message, attachmentNote].filter(Boolean).join("\n");
    report.chat = [...history, { role: "user", content: storedMessage }, { role: "assistant", content: reply }].slice(-24);
    report.updatedAt = new Date().toISOString();
    await writeStore(store);

    response.json({ reply, chat: report.chat });
  } catch (error) {
    console.error("[openai] chat fallo:", error.message);
    response.status(502).json({ error: "No se pudo contactar al agente. Intenta de nuevo en unos segundos." });
  }
});

// "Memoria" del agente: destila el chat de un reporte en reglas perdurables
// y las consolida en un criterio del cliente ("Aprendizajes del chat"). La IA
// separa las reglas permanentes (estilo, datos del negocio, correcciones a
// recordar) de los pedidos puntuales de la semana, que se ignoran.
app.post("/api/module1/reports/:reportId/chat/learn", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);
  if (!report) {
    response.status(404).json({ error: "No se encontró el reporte." });
    return;
  }
  if (!openaiApiKey) {
    response.status(503).json({ error: "La IA no está configurada en el servidor (falta OPENAI_API_KEY)." });
    return;
  }
  const chat = Array.isArray(report.chat) ? report.chat.slice(-30) : [];
  if (!chat.length) {
    response.status(400).json({ error: "Este reporte aún no tiene conversación con el agente." });
    return;
  }

  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const clientName = client?.name || report.clientId;
  const documentName = "Aprendizajes del chat";
  let learningDoc = (store.criteriaDocuments || []).find(
    (document) => document.clientId === report.clientId && document.name === documentName,
  );
  const existingRules = learningDoc ? String(learningDoc.text || "") : "";

  const transcript = chat
    .map((message) => `${message.role === "user" ? "EQUIPO" : "AGENTE"}: ${String(message.content || "").slice(0, 1200)}`)
    .join("\n")
    .slice(0, 12000);

  const prompt = `
Eres el curador de la memoria del agente de reportes Bevinco para el cliente "${clientName}".

De la conversacion de abajo, extrae SOLO instrucciones PERDURABLES que deban aplicarse en TODOS los futuros reportes de este cliente: reglas de estilo o formato, preferencias del equipo, datos permanentes del negocio u operacion, y correcciones que deban recordarse siempre.

IGNORA: pedidos puntuales de este periodo (cifras, productos o hechos de esta semana), saludos, agradecimientos y todo lo que no sirva para el proximo reporte.

Reglas ya guardadas (pueden estar vacias):
${existingRules || "(ninguna todavia)"}

CONVERSACION:
${transcript}

Devuelve UNICAMENTE la lista consolidada final de reglas (las existentes que sigan vigentes + las nuevas, sin duplicados ni contradicciones; si una nueva corrige a una vieja, conserva la nueva). Una regla por linea, comenzando con "- ". Sin encabezados, sin comentarios, sin texto adicional.
`.trim();

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${openaiApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: openaiModel, input: prompt, max_output_tokens: 1500 }),
    });
    const responsePayload = await openaiResponse.json().catch(() => ({}));
    if (!openaiResponse.ok) {
      console.error("[openai] learn fallo:", responsePayload?.error?.message || openaiResponse.status);
      response.status(502).json({ error: "La IA no pudo procesar la conversación. Intenta de nuevo." });
      return;
    }
    const rules = String(extractOpenAiText(responsePayload) || "").trim().slice(0, 15000);
    const ruleCount = (rules.match(/^- /gm) || []).length;
    if (!rules || !ruleCount) {
      response.json({ saved: false, message: "La conversación no aporta reglas perdurables nuevas." });
      return;
    }

    if (!learningDoc) {
      learningDoc = {
        id: `${Date.now()}-${crypto.randomUUID()}`,
        name: documentName,
        type: "text/markdown",
        source: "chat-learn",
        category: "analysis_rules",
        clientId: report.clientId,
        clientName,
        uploadedAt: new Date().toISOString(),
      };
      store.criteriaDocuments = [learningDoc, ...(store.criteriaDocuments || [])].slice(0, 60);
    }
    learningDoc.text = rules;
    learningDoc.size = rules.length;
    learningDoc.updatedAt = new Date().toISOString();

    store.reports.forEach((item) => { item.analysis = null; });
    await writeStore(store);
    response.json({
      saved: true,
      ruleCount,
      documentName,
      clientName,
      criteriaDocuments: store.criteriaDocuments,
    });
  } catch (error) {
    console.error("[openai] learn error:", error.message);
    response.status(502).json({ error: "No se pudo guardar el aprendizaje. Intenta de nuevo en unos segundos." });
  }
});

app.post("/api/module1/reports/:reportId/summary", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).json({ error: "No se encontró el reporte." });
    return;
  }

  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  // Los mensuales son acumulados: no tienen periodo real en Sculpture y una
  // sincronizacion pisaria los totales sumados con datos vacios.
  if (!report.monthly) await syncSculptureSources(store, report);

  const templateSummary = generateReportSummary(store, report);
  const payloadForAI = buildReportPayload(store, report);
  const aiResult = await generateReportAnalysisAI(payloadForAI);

  const generatedSummary = aiResult?.comments || templateSummary;
  report.comments = generatedSummary;
  report.analysis = aiResult?.analysis || generateReportAnalysis(buildReportPayload(store, report));
  report.emailDraft = aiResult?.emailDraft || [
    `Hola,`,
    "",
    `Compartimos el reporte ${report.monthly ? "mensual" : "semanal"} de auditoría de ${client?.name || report.clientId}.`,
    "",
    `El periodo cierra con un costo de ${report.summary?.costPercent || 0}% y una diferencia de inventario de ${moneyPlain(report.summary?.varianceAmount || 0)} (${report.summary?.variancePercent || 0}%).`,
    "",
    "El detalle completo, con gráficos y el desglose por producto, va adjunto en PDF. Quedamos atentos a cualquier duda o comentario.",
  ].join("\n");
  report.analysisSource = aiResult ? "openai" : "template";
  report.updatedAt = new Date().toISOString();

  await writeStore(store);
  response.json(buildReportPayload(store, report));
});

app.get("/api/module1/reports/:reportId/export", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).send("No se encontró el reporte.");
    return;
  }

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.send(renderTwoPageReportHtml(store, report));
});

app.get("/api/module1/reports/:reportId/pdf", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);
  if (!report) {
    response.status(404).json({ error: "No se encontró el reporte." });
    return;
  }
  try {
    const pdf = await renderReportPdf(store, report);
    const client = store.clients.find((candidate) => candidate.id === report.clientId);
    const period = store.periods.find((candidate) => candidate.id === report.periodId);
    const fileName = `Reporte Bevinco - ${client?.name || report.clientId} - ${period?.label || report.periodId}`.replace(/[^\w\s\-áéíóúñÁÉÍÓÚÑ.]/g, "").slice(0, 120);
    response.setHeader("content-type", "application/pdf");
    response.setHeader("content-disposition", `attachment; filename="${fileName}.pdf"`);
    response.send(pdf);
  } catch (error) {
    console.error("[pdf] fallo:", error.stack || error.message);
    response.status(500).json({ error: "No se pudo generar el PDF. Intenta de nuevo." });
  }
});

// "Sugerencia de compra" descargable: la hoja final que el equipo enviaba
// desde Excel, generada directo desde el CMS. Trae el Intelipar fresco de
// Sculpture, completa PAR/sugerencia si es cocina (mismas formulas del
// equipo) y deja solo lo accionable: items con pedido sugerido o con exceso
// de inventario, agrupados por proveedor y con fila de total.
app.get("/api/module1/reports/:reportId/purchase-suggestion", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);
  if (!report) {
    response.status(404).json({ error: "No se encontró el reporte." });
    return;
  }
  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const cid = configuredIdentifier(client?.sculptureCid, client?.cid);
  const period = report.monthly
    ? store.periods.find((candidate) => candidate.id === (report.includedPeriods || []).slice(-1)[0]?.id)
    : store.periods.find((candidate) => candidate.id === report.periodId);
  const pid = configuredIdentifier(period?.sculpturePid, period?.pid);
  if (!cid || !pid) {
    response.status(400).json({ error: "Este reporte no tiene un periodo de Sculpture asociado para la sugerencia." });
    return;
  }

  let data;
  try {
    const area = client?.area || "Food";
    const baseUrl = client?.sculptureBaseUrl || client?.baseUrl || baseUrlForSculptureArea(area);
    data = await fetchSculptureInternalReport({ type: "intelipar", cid, pid, area, baseUrl });
  } catch (error) {
    console.error("[sugerencia-csv] fallo:", error.message);
    response.status(502).json({ error: "Sculpture no respondió la sugerencia de compra. Intenta de nuevo en unos segundos." });
    return;
  }
  if (!data.rows?.length) {
    response.status(404).json({ error: "Sculpture no tiene datos de Intelipar para este periodo." });
    return;
  }

  const periodMs = period?.startsAt && period?.endsAt ? Date.parse(period.endsAt) - Date.parse(period.startsAt) : 0;
  const daysInPeriod = periodMs > 0 ? Math.round(periodMs / 86400000) + 1 : 7;
  const isKitchenTable = !(data.rows || []).some((row) => {
    const record = row.record || {};
    return record.par !== undefined || record.orden !== undefined || record.costoPedido !== undefined;
  });
  if (isKitchenTable) {
    try {
      const area = client?.area || "Food";
      const baseUrl = client?.sculptureBaseUrl || client?.baseUrl || baseUrlForSculptureArea(area);
      const detailed = await fetchSculptureInternalReport({ type: "varianceDetailed", cid, pid, area, baseUrl });
      applyEffectiveInventory(data.rows, buildDetailedStockMap(detailed.rows), client);
    } catch (detailedError) {
      // Sin detailed se usa el stock del Intelipar tal cual.
      console.error("[sugerencia-csv] detailed no disponible:", detailedError.message);
    }
  }
  enrichKitchenIntelipar(data.rows, { daysInPeriod, params: client?.purchaseParams });

  const items = data.rows
    .map((row) => {
      const record = row.record || {};
      const name = pickRecordValue(record, ["itemName", "item"], "") ||
        pickRecordValueFuzzy(record, /nombreArt/i) ||
        row.values?.[0] || "";
      if (!name || isTotalRow(name) || /:\s*$/.test(name)) return null;
      return {
        provider: String(pickRecordValue(record, ["proveedor", "provider", "vendor"], "") || pickRecordValueFuzzy(record, /proveedor|vendor/i) || "Por validar").trim(),
        name: String(name).trim(),
        size: String(pickRecordValueFuzzy(record, /tama/i) || "").trim(),
        unitCost: parseNumber(pickRecordValueFuzzy(record, /costoUnit/i)),
        onHand: parseNumber(record.existencia),
        onHandCost: parseNumber(record.existenciaCosto),
        par: parseNumber(record.par),
        suggested: parseNumber(record.orden),
        orderCost: parseNumber(record.costoPedido),
        inventoryDays: parseNumber(pickRecordValue(record, ["dAsRestantes", "diasRestantes", "daysRemaining"], "") || pickRecordValueFuzzy(record, /restantes|inventarioEnDias/i)),
        excessCost: parseNumber(pickRecordValue(record, ["excesoDeInventario", "excessInventory"], "") || pickRecordValueFuzzy(record, /exceso/i)),
        // Mismo dato marcado que ve la auditora en el reporte: sin esto el CSV
        // que se manda al proveedor lista "Champiñon Ostra / PAR 1 / Compra
        // Sugerida 1 / Costo de la compra 0" sin ninguna explicacion.
        alerta: pickRecordValue(record, ["alertaCosto"], ""),
      };
    })
    .filter((item) => item && (item.suggested > 0 || item.excessCost > 0))
    .sort((left, right) => left.provider.localeCompare(right.provider, "es") || left.name.localeCompare(right.name, "es"));

  const escapeCsv = (value) => {
    const text = String(value ?? "");
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const money = (value) => (value ? Math.round(value) : 0);
  const qty = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : 0);

  const lines = [
    ["Proveedor", "Nombre Articulo", "Tamaño Articulo", "Costo unit. ($)", "Inventario", "Inventario al costo ($)", "PAR", "Compra Sugerida", "Costo de la compra ($)", "Inventario en días", "Exceso de inventario ($)", "Alerta"].map(escapeCsv).join(";"),
  ];
  let lastProvider = "";
  const totals = { onHandCost: 0, suggested: 0, orderCost: 0, excessCost: 0 };
  for (const item of items) {
    lines.push([
      item.provider === lastProvider ? "" : item.provider,
      item.name,
      item.size,
      money(item.unitCost),
      qty(item.onHand),
      money(item.onHandCost),
      qty(item.par),
      qty(item.suggested),
      money(item.orderCost),
      qty(item.inventoryDays),
      money(item.excessCost),
      item.alerta,
    ].map(escapeCsv).join(";"));
    lastProvider = item.provider;
    totals.onHandCost += item.onHandCost;
    totals.suggested += item.suggested;
    totals.orderCost += item.orderCost;
    totals.excessCost += item.excessCost;
  }
  lines.push(["Total general", "", "", "", "", money(totals.onHandCost), "", qty(totals.suggested), money(totals.orderCost), "", money(totals.excessCost), ""].map(escapeCsv).join(";"));

  const fileName = `Sugerencia de compra - ${client?.name || report.clientId} - ${period?.label || report.periodId}`
    .replace(/[^\w\s\-áéíóúñÁÉÍÓÚÑ.]/g, "")
    .slice(0, 120);
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", `attachment; filename="${fileName}.csv"`);
  response.send(Buffer.from("\uFEFF" + lines.join("\r\n"), "utf8"));
});

// Trae el variance detallado fresco desde Sculpture y lo convierte a CSV
// (delimitado por ";" para que Excel en español lo abra en columnas y con BOM
// para que respete tildes). En los mensuales concatena las semanas incluidas
// con una columna "Semana". Devuelve null si Sculpture no entrega filas.
async function buildVarianceCsvAttachment(store, report) {
  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const cid = configuredIdentifier(client?.sculptureCid, client?.cid);
  if (!cid) return null;
  const area = client?.area || "Food";
  const baseUrl = client?.sculptureBaseUrl || client?.baseUrl || baseUrlForSculptureArea(area);

  const targetPeriods = report.monthly
    ? (report.includedPeriods || []).map((item) => store.periods.find((period) => period.id === item.id)).filter(Boolean)
    : [store.periods.find((period) => period.id === report.periodId)].filter(Boolean);
  if (!targetPeriods.length) return null;

  const escapeCsv = (value) => {
    const text = String(value ?? "");
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [];
  let headersWritten = false;
  for (const period of targetPeriods) {
    const pid = configuredIdentifier(period.sculpturePid, period.pid);
    if (!pid) continue;
    let data;
    try {
      data = await fetchSculptureInternalReport({ type: "varianceDetailed", cid, pid, area, baseUrl });
    } catch (error) {
      console.error(`[variance-csv] ${period.id}: ${error.message}`);
      continue; // semana sin datos: el CSV sale con las que respondieron
    }
    if (!data.rows?.length) continue;
    if (!headersWritten) {
      lines.push([...(report.monthly ? ["Semana"] : []), ...(data.headers || [])].map(escapeCsv).join(";"));
      headersWritten = true;
    }
    for (const row of data.rows) {
      lines.push([...(report.monthly ? [period.label || period.id] : []), ...(row.values || [])].map(escapeCsv).join(";"));
    }
  }
  if (!lines.length) return null;

  const period = store.periods.find((candidate) => candidate.id === report.periodId);
  const filename = `Variance detallado - ${client?.name || report.clientId} - ${period?.label || report.periodId}`
    .replace(/[^\w\s\-áéíóúñÁÉÍÓÚÑ.]/g, "")
    .slice(0, 120) + ".csv";
  return { filename, buffer: Buffer.from("\uFEFF" + lines.join("\r\n"), "utf8") };
}

app.post("/api/module1/reports/:reportId/email", requireAuth, async (request, response) => {
  const store = await readStore();
  const report = findReport(store, request.params.reportId);

  if (!report) {
    response.status(404).json({ error: "No se encontró el reporte." });
    return;
  }

  const client = store.clients.find((candidate) => candidate.id === report.clientId);
  const rawRecipients = Array.isArray(request.body?.recipients) && request.body.recipients.length
    ? request.body.recipients
    : client?.recipients || [];
  const recipients = [...new Set(rawRecipients.map((email) => String(email).trim().toLowerCase()).filter((email) => /^[^s@]+@[^s@]+.[^s@]+$/.test(email)))];

  if (!recipients.length && process.env.RESEND_API_KEY) {
    response.status(400).json({ error: "Agrega al menos un destinatario válido antes de enviar." });
    return;
  }

  const isMonthly = Boolean(report.monthly);
  const defaultSubject = `Reporte ${isMonthly ? "mensual" : "semanal"} Bevinco - ${client?.name || report.clientId}`;
  const subject = String(request.body?.subject || "").trim().slice(0, 160) || defaultSubject;

  if (!gmailConfigured && !process.env.RESEND_API_KEY) {
    response.json({
      prepared: true,
      sent: false,
      message: "El correo no está configurado (falta GMAIL_USER/GMAIL_APP_PASSWORD o RESEND_API_KEY). El borrador quedó listo.",
      recipients,
      subject,
      body: report.emailDraft,
    });
    return;
  }

  let reportPdf;
  try {
    reportPdf = await renderReportPdf(store, report);
  } catch (pdfError) {
    console.error("[pdf] fallo al adjuntar:", pdfError.stack || pdfError.message);
    response.status(500).json({ error: "No se pudo generar el PDF adjunto. Intenta de nuevo en unos segundos." });
    return;
  }

  // Variance detallado fresco (pedido de Pedro): va como segundo adjunto.
  // Si Sculpture no responde, el correo sale igual solo con el PDF.
  let varianceCsv = null;
  try {
    varianceCsv = await buildVarianceCsvAttachment(store, report);
  } catch (varianceError) {
    console.error("[variance-csv] no se pudo adjuntar:", varianceError.message);
  }

  const pdfFilename = `${subject.replace(/[^\w\s\-áéíóúñÁÉÍÓÚÑ.]/g, "").slice(0, 120)}.pdf`;

  if (gmailConfigured) {
    try {
      const transport = await getGmailTransport();
      await transport.sendMail({
        from: process.env.REPORTS_FROM_EMAIL || `Bevinco Reportes <${gmailUser}>`,
        to: recipients.join(", "),
        replyTo: process.env.REPORTS_REPLY_TO || gmailUser,
        subject,
        html: renderEmailShellHtml({ clientName: client?.name || report.clientId, bodyText: report.emailDraft || "" }),
        attachments: [
          { filename: pdfFilename, content: reportPdf, contentType: "application/pdf" },
          ...(varianceCsv ? [{ filename: varianceCsv.filename, content: varianceCsv.buffer, contentType: "text/csv" }] : []),
        ],
      });
    } catch (gmailError) {
      console.error("[gmail] envio fallo:", gmailError.message);
      response.status(502).json({
        error: /invalid login|username and password/i.test(String(gmailError.message))
          ? "Gmail rechazó las credenciales: revisa GMAIL_USER y la contraseña de aplicación."
          : "No se pudo enviar por Gmail. Intenta de nuevo en unos segundos.",
      });
      return;
    }

    report.status = "Enviado";
    report.emailLog = { sentAt: new Date().toISOString(), recipients, subject };
    report.updatedAt = new Date().toISOString();
    if (client) client.recipients = recipients;
    await writeStore(store);
    response.json({ sent: true, via: "gmail", report: buildReportPayload(store, report) });
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
      // Las respuestas del cliente llegan al equipo aunque el remitente sea
      // un dominio de envio (Resend) distinto.
      reply_to: process.env.REPORTS_REPLY_TO || undefined,
      subject,
      html: renderEmailShellHtml({ clientName: client?.name || report.clientId, bodyText: report.emailDraft || "" }),
      attachments: [
        { filename: pdfFilename, content: reportPdf.toString("base64") },
        ...(varianceCsv ? [{ filename: varianceCsv.filename, content: varianceCsv.buffer.toString("base64") }] : []),
      ],
    }),
  });

  const payload = await resendResponse.json();
  if (!resendResponse.ok) {
    response.status(resendResponse.status).json(payload);
    return;
  }

  report.status = "Enviado";
  report.emailLog = { sentAt: new Date().toISOString(), recipients, subject };
  report.updatedAt = new Date().toISOString();
  if (client) client.recipients = recipients;
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

// Cambiar el estado de una tarea directamente en ClickUp (tablero del inicio).
app.put("/api/clickup/tasks/:taskId", requireAuth, async (request, response) => {
  try {
    const status = String(request.body?.status || "").trim();
    if (!status) {
      response.status(400).json({ error: "Falta el estado de destino." });
      return;
    }
    const { payload } = await clickupRequest(`/task/${encodeURIComponent(request.params.taskId)}`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
    response.json({ task: mapClickupTask(payload) });
  } catch (error) {
    response.status(error.status || 500).json({
      error: error.message || "No se pudo actualizar la tarea en ClickUp.",
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
    response.status(404).json({ error: "No se encontró el reporte." });
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

// Manejador global: cualquier excepcion no capturada en una ruta responde
// JSON legible (y queda logueada) en lugar de la pagina HTML de Express.
app.use((error, _request, response, _next) => {
  console.error("[error]", error?.stack || error?.message || error);
  if (response.headersSent) return;
  response.status(error?.status || 500).json({
    error: "Error interno del servidor. Intenta de nuevo en unos segundos.",
  });
});

app.listen(port, () => {
  console.log(
    supabaseConfigured
      ? `[supabase] respaldo configurado (${supabaseUrl.replace(/^https?:\/\//, "")})`
      : "[supabase] SIN CONFIGURAR: los reportes y criterios no sobreviviran reinicios",
  );
  console.log(`Bevinco CMS listening on port ${port}`);
});
