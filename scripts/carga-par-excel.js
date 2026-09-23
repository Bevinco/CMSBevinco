// Carga en bloque los PAR fijos de un local desde un Excel del equipo.
// El archivo debe tener una fila de encabezado y las columnas:
//   Nombre Articulo | Proveedor | PAR
//
// Uso (PowerShell, desde la carpeta del proyecto):
//   $env:BV_USER="gerencia@bevinco.com"; $env:BV_PASS="<clave>"
//
//   node scripts/carga-par-excel.js "<archivo.xlsx>" <clientId>            (simula)
//   node scripts/carga-par-excel.js "<archivo.xlsx>" <clientId> --aplicar  (carga)
//
// Por defecto SIMULA: muestra que producto calza con el local y cual no, sin
// tocar nada. Un producto que no calza por nombre se ignora en silencio si se
// carga a ciegas, asi que conviene revisar la simulacion primero.

import ExcelJS from "exceljs";

const BASE = process.env.BV_URL || "https://bevinco.onrender.com";
const USER = process.env.BV_USER || "";
const PASS = process.env.BV_PASS || "";
const [ARCHIVO, CLIENTE] = process.argv.slice(2);
const APLICAR = process.argv.includes("--aplicar");

// Los Excel que llegan por WhatsApp suelen venir con la codificacion rota
// ("ChampiÃ±on Ostra"): se repara antes de comparar, si no ese producto nunca
// calzaria y se perderia sin aviso.
const repara = (texto) => {
  const t = String(texto || "");
  if (!/[ÃÂ]/.test(t)) return t;
  try { return Buffer.from(t, "latin1").toString("utf8"); } catch { return t; }
};
const clave = (nombre) => repara(nombre).trim().toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

let cookie = "";
const api = async (ruta, opciones = {}) => {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones, headers: { ...(opciones.headers || {}), ...(cookie ? { cookie } : {}) },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const texto = await res.text();
  try { return { status: res.status, json: JSON.parse(texto) }; }
  catch { return { status: res.status, texto: texto.slice(0, 250) }; }
};

(async () => {
  if (!ARCHIVO || !CLIENTE) {
    console.error('Uso: node scripts/carga-par-excel.js "<archivo.xlsx>" <clientId> [--aplicar]');
    process.exit(1);
  }
  if (!USER || !PASS) {
    console.error("Falta BV_USER o BV_PASS. Mira el encabezado de este archivo.");
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ARCHIVO);
  const ws = wb.worksheets[0];
  const lista = [];
  ws.eachRow((row, indice) => {
    if (indice === 1) return; // encabezado
    const nombre = repara(String(row.getCell(1).value ?? "")).trim();
    const par = Number(row.getCell(3).value);
    if (nombre && Number.isFinite(par) && par >= 0) lista.push({ nombre, par });
  });
  if (!lista.length) {
    console.error("No encontre filas con nombre y PAR. Revisa que las columnas sean Nombre | Proveedor | PAR.");
    process.exit(1);
  }
  console.log(`${ARCHIVO}: ${lista.length} productos con PAR\n`);

  const login = await api("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (login.status !== 200) {
    console.error("No pude entrar al CMS:", login.status, JSON.stringify(login.json || login.texto));
    process.exit(1);
  }

  const actual = await api(`/api/module1/clients/${CLIENTE}/purchase-suggestion`);
  const items = actual.json?.items || [];
  if (!items.length) {
    console.error("El local no devolvio productos:", JSON.stringify(actual.json || actual.texto).slice(0, 200));
    process.exit(1);
  }
  const nombreLocal = actual.json?.client?.name || CLIENTE;
  const area = actual.json?.client?.area || "";
  if (!/food/i.test(area)) {
    console.error(`OJO: "${nombreLocal}" es ${area}. En barra el PAR lo entrega Sculpture y fijarlo no tiene efecto.`);
    process.exit(1);
  }

  const porClave = new Map(items.map((item) => [clave(item.name), item]));
  const calzan = [];
  const huerfanos = [];
  for (const fila of lista) {
    const item = porClave.get(clave(fila.nombre));
    if (item) calzan.push({ ...fila, item });
    else huerfanos.push(fila);
  }

  console.log(`Local: ${nombreLocal}  (${items.length} productos en la sugerencia)\n`);
  console.log(`CALZAN ${calzan.length}:`);
  for (const x of calzan) {
    const actualPar = x.item.par ? Math.round(x.item.par) : 0;
    console.log(`   ${x.nombre.padEnd(26)} PAR ${String(actualPar).padStart(4)} -> ${String(x.par).padStart(4)}${actualPar === x.par ? "  (igual)" : ""}`);
  }
  if (huerfanos.length) {
    console.log(`\nNO CALZAN ${huerfanos.length} (se ignoran: el nombre no existe en el local):`);
    for (const x of huerfanos) console.log(`   ${x.nombre}  (PAR ${x.par})`);
  }

  if (!APLICAR) {
    console.log(`\nSimulacion: no se toco nada. Agrega --aplicar para cargar los ${calzan.length} que calzan.`);
    return;
  }
  if (!calzan.length) { console.log("\nNada que cargar."); return; }

  const cuerpo = {};
  for (const x of calzan) cuerpo[x.item.name] = x.par;
  const r = await api(`/api/module1/clients/${CLIENTE}/par-fijo`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: cuerpo }),
  });
  if (r.status !== 200) {
    console.error("\nNo se pudo cargar:", r.status, JSON.stringify(r.json || r.texto));
    process.exit(1);
  }
  console.log(`\nListo: ${r.json.fijados} producto(s) con PAR fijo en ${nombreLocal}.`);
  console.log("Para verlo en los reportes hay que regenerar las semanas.");
})();
