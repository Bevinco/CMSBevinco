// Auditoria de familias de la compra sugerida, local por local.
//
// Comprueba, para la ultima semana cerrada de cada restaurante, que la
// sugerencia por familia del CMS sea exactamente la que sale de Sculpture:
//
//   1. NOMBRES: toda familia del CMS existe en el variance summary de Sculpture
//      (nada de "Vinos" si Sculpture dice "Vino", ni "Otros", ni "Cocina").
//   2. MONTO POR FAMILIA: el monto de cada familia es la suma de sus productos,
//      agrupados con la jerarquia de Sculpture (hoja -> familia). Es el chequeo
//      que habria detectado Candelaria: "Cervezas y Cocteles" = cerveza +
//      cocteles.
//   3. CONSERVACION: el total del CMS es el total de los productos. Si hay plata
//      que no cae en ninguna familia auditada, se informa aparte.
//
// El calculo esperado se hace AQUI, leyendo el dato crudo de Sculpture, sin
// reutilizar el agrupador del CMS: si ambos coinciden es porque el CMS esta
// bien, no porque se compare consigo mismo.
//
// Uso (PowerShell, desde la carpeta del proyecto):
//   $env:BV_TOKEN="bvk_..."            (o BV_USER + BV_PASS)
//   node scripts/auditoria-familias.js                 audita lo guardado (no escribe nada)
//   node scripts/auditoria-familias.js --regenerar     regenera la semana antes (ESCRIBE)
//   node scripts/auditoria-familias.js --solo 24600    un local (cid o id)
//
// Sale con codigo 1 si encuentra fallas, para poder usarlo en automatizaciones.

const BASE = process.env.BV_URL || "https://bevinco.onrender.com";
const TOKEN = process.env.BV_TOKEN || "";
const USER = process.env.BV_USER || "";
const PASS = process.env.BV_PASS || "";
const REGENERAR = process.argv.includes("--regenerar");
const SOLO = (() => {
  const i = process.argv.indexOf("--solo");
  return i >= 0 ? String(process.argv[i + 1] || "") : "";
})();
const PAUSA_MS = 5000; // Sculpture se cae si se le pide todo de golpe.
const TOLERANCIA = (monto) => Math.max(1000, Math.abs(monto) * 0.01);

// Grupos que el CMS no muestra como familia de compra (ver grupoNoComprable en
// server/index.js). Su plata se informa, pero no cuenta como falla de nombre.
const NO_COMPRABLE = /^(no auditados?.*|unknown|sin categor.*|aseo|auditoria mensual|otros)$/i;

let cookie = "";
const api = async (ruta, opciones = {}) => {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      ...(opciones.headers || {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const texto = await res.text();
  try { return { status: res.status, json: JSON.parse(texto) }; }
  catch { return { status: res.status, json: null, texto: texto.slice(0, 200) }; }
};
const espera = (ms) => new Promise((listo) => setTimeout(listo, ms));

// Misma normalizacion que familyMergeKey del servidor: sin tildes, sin plural,
// sin "por unidad". Se reescribe aqui a proposito, para no depender del codigo
// que se esta auditando.
const clave = (nombre) => {
  const limpio = String(nombre || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const base = limpio.replace(/\s+(?:por\s+|x\s+)?unidad(?:es)?$/, "").trim();
  const texto = base && !/^(?:por|x|de)$/.test(base) ? base : limpio;
  return texto.split(/\s+/).filter(Boolean).map((p) => p.replace(/s$/, "").replace(/e$/, "")).join("");
};
const numero = (valor) => {
  const n = parseFloat(String(valor ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const plata = (n) => `$${Math.round(n || 0).toLocaleString("es-CL")}`;
const nombreFila = (fila) => String(Object.values(fila || {})[0] ?? "").trim();
const conDatos = (fila) => Object.values(fila || {}).slice(1).some((v) => String(v ?? "").trim() !== "");
const sinTotal = (nombre) => String(nombre).replace(/^total\s+/i, "").replace(/:\s*$/, "").trim();

// Jerarquia oficial desde el variance summary: familias y hoja -> familia.
function jerarquiaDelSummary(filas) {
  const familias = new Map(); // clave -> nombre
  const hojaAFamilia = new Map(); // clave de hoja -> nombre de familia
  let actual = "";
  let hojas = [];
  for (const fila of filas) {
    const nombre = nombreFila(fila);
    if (!nombre || /^grand\s*total/i.test(nombre)) { actual = ""; hojas = []; continue; }
    if (/^total\s+/i.test(nombre)) {
      const familia = sinTotal(nombre);
      if (actual && clave(familia) === clave(actual)) {
        familias.set(clave(actual), actual);
        for (const hoja of hojas) hojaAFamilia.set(hoja, actual);
      }
      if (clave(familia) === clave(actual)) { actual = ""; hojas = []; }
      continue;
    }
    if (/:\s*$/.test(nombre)) { if (actual) hojas.push(clave(sinTotal(nombre))); continue; }
    if (!conDatos(fila)) { actual = nombre; hojas = []; }
  }
  return { familias, hojaAFamilia };
}

// Monto esperado por familia a partir de productos {nombre, hoja, encabezado, costo}.
function esperadoPorFamilia(productos, { familias, hojaAFamilia }) {
  const monto = new Map();
  const fuera = new Map(); // grupos que no estan en el variance, con su plata
  for (const p of productos) {
    if (!(p.costo > 0)) continue;
    // Primero el encabezado de familia bajo el que esta el producto en el
    // arbol: es posicional y por eso exacto. Por nombre de hoja no alcanza,
    // porque un mismo nombre puede colgar de dos familias (en El Muelle hay
    // "Porcion:" dentro de Carnes Y dentro de Pescado). La hoja solo se usa
    // cuando el Intelipar no trae encabezados.
    const porEncabezado = p.encabezado && familias.has(clave(p.encabezado)) ? familias.get(clave(p.encabezado)) : "";
    // Si hay encabezado pero NO es familia auditada (Cafeteria, No
    // Auditados), el producto se queda en ese grupo: no se "rescata" hacia
    // otra familia por parecido de nombre de hoja.
    const porHoja = p.encabezado ? "" : hojaAFamilia.get(clave(p.hoja));
    const familia = porEncabezado || porHoja;
    if (familia) monto.set(clave(familia), (monto.get(clave(familia)) || 0) + p.costo);
    else {
      const grupo = p.encabezado || p.hoja || "(sin grupo)";
      fuera.set(grupo, (fuera.get(grupo) || 0) + p.costo);
    }
  }
  return { monto, fuera };
}

// Productos del Intelipar crudo con su hoja y su encabezado de familia.
function productosDelIntelipar(filas, costoDe) {
  const productos = [];
  let encabezado = "";
  let hoja = "";
  filas.forEach((fila, i) => {
    const nombre = nombreFila(fila);
    if (!nombre || /^grand\s*total/i.test(nombre) || /^total\s+/i.test(nombre)) return;
    if (/:\s*$/.test(nombre)) { hoja = sinTotal(nombre); return; }
    let siguiente = "";
    for (let j = i + 1; j < filas.length; j += 1) { const s = nombreFila(filas[j]); if (s) { siguiente = s; break; } }
    if (!conDatos(fila) && /:\s*$/.test(siguiente) && !/^total\s+/i.test(siguiente)) { encabezado = nombre; hoja = ""; return; }
    productos.push({ nombre, hoja, encabezado, costo: costoDe(fila, nombre) });
  });
  return productos;
}

async function auditaLocal(cliente, reportesGuardados) {
  const area = /food/i.test(cliente.area || "") ? "Food" : "Beverage";
  const cid = cliente.sculptureCid || cliente.cid;
  const cuenta = cliente.sculptureAccountId && cliente.sculptureAccountId !== "principal"
    ? `&accountId=${encodeURIComponent(cliente.sculptureAccountId)}` : "";
  const resultado = { local: cliente.name, area, estado: "OK", detalle: [], fuera: 0 };

  const per = await api(`/api/module1/sculpture-units/periods?cid=${cid}&area=${area}${cuenta}`);
  const hoy = new Date().toISOString().slice(0, 10);
  const semana = (per.json?.periods || []).find((p) => p.endsAt && p.endsAt < hoy && p.startsAt
    && (Date.parse(p.endsAt) - Date.parse(p.startsAt)) / 86400000 + 1 >= 6);
  if (!semana) {
    resultado.estado = "SIN DATOS";
    resultado.detalle.push(per.json?.error || "sin semana cerrada (¿cuenta de Sculpture no configurada?)");
    return resultado;
  }
  resultado.semana = semana.label;

  // Reporte del CMS: regenerado ahora o el que esta guardado.
  let reporte = null;
  if (REGENERAR) {
    await espera(PAUSA_MS);
    const q = await api("/api/module1/sculpture/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: cliente.id, periodId: semana.id }),
    });
    reporte = q.json?.selectedReport || null;
  } else {
    reporte = reportesGuardados.find((r) => r.clientId === cliente.id && r.periodId === semana.id && !r.monthly) || null;
  }
  if (!reporte) {
    resultado.estado = "SIN REPORTE";
    resultado.detalle.push(REGENERAR ? "no se pudo regenerar" : `no hay reporte guardado de ${semana.label} (usa --regenerar)`);
    return resultado;
  }

  await espera(PAUSA_MS);
  const summary = await api(`/api/module1/sculpture-source?type=varianceSummary&cid=${cid}&area=${area}&pid=${semana.pid}${cuenta}&limit=500`);
  const jerarquia = jerarquiaDelSummary(summary.json?.rows || []);
  if (jerarquia.familias.size < 2) {
    resultado.estado = "SIN DATOS";
    resultado.detalle.push("el variance summary no trajo familias");
    return resultado;
  }

  // Productos con su costo de pedido. Barra: Sculpture lo trae en el
  // Intelipar. Cocina: lo calcula el CMS (Sculpture no lo da) y queda en
  // familyRows del reporte; se toma de ahi el costo, pero la AGRUPACION se
  // rehace aqui con la jerarquia de Sculpture.
  let productos = [];
  if (area === "Beverage") {
    await espera(PAUSA_MS);
    const inteli = await api(`/api/module1/sculpture-source?type=intelipar&cid=${cid}&area=${area}&pid=${semana.pid}${cuenta}&limit=800`);
    productos = productosDelIntelipar(inteli.json?.rows || [], (fila) => numero(fila.costoPedido));
  } else {
    // El costo va pegado a CADA fila, no buscado por nombre: hay productos con
    // el nombre repetido (una capsula Lavazza dos veces en El Muelle) y un
    // mapa por nombre dejaba que una fila pisara el costo de la otra.
    const filas = (reporte.familyRows || []).map((f) => {
      const fila = { nombreArtCulo: f.name };
      if (!f.empty) fila.dato = "x";
      // No enumerable: si no, una fila vacia "tendria datos" (el 0 del costo)
      // y se romperia la deteccion de encabezados de familia.
      Object.defineProperty(fila, "costoFila", { value: Number(f.cost) || 0, enumerable: false });
      return fila;
    });
    productos = productosDelIntelipar(filas, (fila) => fila.costoFila || 0);
    if (!productos.length) {
      resultado.detalle.push("reporte sin filas de origen (anterior a familyRows): se revisan solo los nombres");
    }
  }
  const esperado = esperadoPorFamilia(productos, jerarquia);
  const cms = new Map();
  for (const f of reporte.familySuggested || []) {
    cms.set(clave(f.family), { nombre: f.family, monto: (cms.get(clave(f.family))?.monto || 0) + (f.suggested || 0) });
  }

  // 1. Nombres. Una familia que Sculpture no audita esta semana es FALLA solo
  // si trae plata: ahi el dinero esta bajo un nombre que el cliente no
  // reconoce. En $0 es un aviso — no mueve nada y el grafico ya la oculta.
  for (const [k, f] of cms) {
    if (jerarquia.familias.has(k) || NO_COMPRABLE.test(String(f.nombre).trim())) continue;
    if (Math.abs(f.monto) >= 1) {
      resultado.estado = "FALLA";
      resultado.detalle.push(`familia "${f.nombre}" con ${plata(f.monto)} no existe en Sculpture`);
    } else {
      resultado.detalle.push(`aviso: familia "${f.nombre}" en $0 no esta en el variance de esta semana`);
    }
  }

  // 2. Monto por familia (solo si hay productos para comparar)
  if (productos.length) {
    for (const [k, nombre] of jerarquia.familias) {
      const deCms = cms.get(k)?.monto || 0;
      const deSculpture = esperado.monto.get(k) || 0;
      if (Math.abs(deCms - deSculpture) > TOLERANCIA(deSculpture)) {
        resultado.estado = "FALLA";
        resultado.detalle.push(`${nombre}: CMS ${plata(deCms)} vs Sculpture ${plata(deSculpture)} (dif ${plata(deCms - deSculpture)})`);
      }
    }
    // 3. Conservacion
    const totalCms = [...cms.values()].reduce((s, f) => s + f.monto, 0);
    const totalProductos = productos.reduce((s, p) => s + (p.costo > 0 ? p.costo : 0), 0);
    if (Math.abs(totalCms - totalProductos) > TOLERANCIA(totalProductos)) {
      resultado.estado = "FALLA";
      resultado.detalle.push(`total CMS ${plata(totalCms)} vs total de productos ${plata(totalProductos)}`);
    }
    resultado.fuera = [...esperado.fuera.values()].reduce((s, v) => s + v, 0);
    for (const [grupo, monto] of esperado.fuera) resultado.detalle.push(`aviso: ${plata(monto)} en "${grupo}", grupo que el variance no audita`);
  }
  return resultado;
}

(async () => {
  if (!TOKEN && (!USER || !PASS)) {
    console.error("Falta BV_TOKEN, o bien BV_USER y BV_PASS.");
    process.exit(2);
  }
  if (!TOKEN) {
    const login = await api("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    if (login.status !== 200) { console.error("No pude entrar al CMS:", login.status); process.exit(2); }
  }

  const inicio = await api("/api/module1/bootstrap");
  const clientes = (inicio.json?.clients || [])
    .filter((c) => !SOLO || String(c.sculptureCid || c.cid) === SOLO || c.id === SOLO)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
  const guardados = inicio.json?.reports || [];
  console.log(`Auditoria de familias · ${clientes.length} locales · ${REGENERAR ? "REGENERANDO la ultima semana" : "sobre lo guardado"}\n`);

  const resultados = [];
  for (const cliente of clientes) {
    let r;
    try { r = await auditaLocal(cliente, guardados); }
    catch (error) { r = { local: cliente.name, area: cliente.area, estado: "ERROR", detalle: [error.message] }; }
    resultados.push(r);
    const marca = { OK: "OK    ", FALLA: "FALLA ", "SIN DATOS": "--    ", "SIN REPORTE": "--    ", ERROR: "ERROR " }[r.estado] || r.estado;
    console.log(`${marca} ${r.local}${r.semana ? ` · ${r.semana}` : ""}`);
    for (const linea of r.detalle) console.log(`         ${linea}`);
  }

  const cuenta = (estado) => resultados.filter((r) => r.estado === estado).length;
  console.log(`\n${cuenta("OK")} OK · ${cuenta("FALLA")} con fallas · ${cuenta("SIN DATOS") + cuenta("SIN REPORTE")} sin datos · ${cuenta("ERROR")} con error`);
  process.exit(cuenta("FALLA") || cuenta("ERROR") ? 1 : 0);
})();
