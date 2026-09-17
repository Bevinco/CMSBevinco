// Regenera en PRODUCCION los reportes de De la Ostia cocina cuya sugerencia
// quedo agrupada bajo familias que no existen en una cocina ("Cocina",
// "Vinos", "Destilados"...). Esa plata quedo SUMADA dentro de esas familias y
// no hay forma de repartirla de vuelta sin volver a pedirle los datos a
// Sculpture, asi que estos son los unicos reportes que necesitan regenerarse.
//
// Uso (PowerShell, desde la carpeta del proyecto):
//   $env:BV_USER="gerencia@bevinco.com"; $env:BV_PASS="<clave>"; node scripts/regenera-de-la-ostia.js
//
// Para ver que haria sin tocar nada:
//   $env:BV_USER="..."; $env:BV_PASS="..."; node scripts/regenera-de-la-ostia.js --simular
//
// No toca comentarios, ni correos, ni ningun otro local: solo vuelve a pedirle
// a Sculpture los datos de esas semanas y reescribe la agrupacion por familia.

const BASE = process.env.BV_URL || "https://bevinco.onrender.com";
const USER = process.env.BV_USER || "";
const PASS = process.env.BV_PASS || "";
const CLIENTE = process.env.BV_CLIENTE || "27098-cocina"; // De la Ostia cocina
const SIMULAR = process.argv.includes("--simular");
const PAUSA_MS = 8000; // Sculpture se cae si se le pide todo de golpe.

// Familias que solo existen en BARRA: si aparecen en una cocina, la sugerencia
// de esa semana se agrupo con la taxonomia equivocada.
const FAMILIAS_DE_BARRA = /^(cocina|vinos?|destilados?|espumantes?|cervezas? y sidra|barriles?|sin alcohol)$/i;

let cookie = "";
const api = async (ruta, opciones = {}) => {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: { ...(opciones.headers || {}), ...(cookie ? { cookie } : {}) },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const texto = await res.text();
  try { return { status: res.status, json: JSON.parse(texto) }; }
  catch { return { status: res.status, json: null, texto: texto.slice(0, 300) }; }
};
const espera = (ms) => new Promise((listo) => setTimeout(listo, ms));
const familias = (reporte) => (reporte?.familySuggested || []).map((f) => f.family);

(async () => {
  if (!USER || !PASS) {
    console.error("Falta BV_USER o BV_PASS. Mira el encabezado de este archivo.");
    process.exit(1);
  }

  const login = await api("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (login.status !== 200) {
    console.error("No pude entrar al CMS:", login.status, JSON.stringify(login.json || login.texto));
    process.exit(1);
  }
  console.log(`Conectado a ${BASE}\n`);

  const inicio = await api("/api/module1/bootstrap");
  const reportes = (inicio.json?.reports || []).filter((r) => r.clientId === CLIENTE && !r.monthly);
  const periodos = new Map((inicio.json?.periods || []).map((p) => [p.id, p]));
  if (!reportes.length) {
    console.error(`No encontre reportes de ${CLIENTE}.`);
    process.exit(1);
  }

  const aRegenerar = reportes.filter((r) => familias(r).some((f) => FAMILIAS_DE_BARRA.test(String(f).trim())));
  console.log(`${reportes.length} reportes de ese local · ${aRegenerar.length} con familias de barra\n`);
  if (!aRegenerar.length) {
    console.log("Nada que regenerar: ninguno quedo agrupado con familias de barra.");
    return;
  }

  for (const r of aRegenerar) {
    const etiqueta = periodos.get(r.periodId)?.label || r.periodId;
    const antes = familias(r);
    console.log(`── ${etiqueta}`);
    console.log(`   antes:  ${antes.join(", ")}`);
    if (SIMULAR) { console.log("   (simulacion: no se toca)\n"); continue; }

    try {
      const q = await api("/api/module1/sculpture/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: CLIENTE, periodId: r.periodId }),
      });
      const nuevo = q.json?.selectedReport;
      if (!nuevo) { console.log(`   ERROR ${q.status}: ${JSON.stringify(q.json || q.texto).slice(0, 180)}\n`); continue; }
      const despues = familias(nuevo);
      const quedan = despues.filter((f) => FAMILIAS_DE_BARRA.test(String(f).trim()));
      console.log(`   ahora:  ${despues.join(", ")}`);
      console.log(`   ${quedan.length ? `OJO, quedan familias de barra: ${quedan.join(", ")}` : "OK, sin familias de barra"}\n`);
    } catch (error) {
      console.log(`   ERROR: ${error.message}\n`);
    }
    await espera(PAUSA_MS);
  }

  console.log("Listo. Abre un reporte del local para confirmar el grafico por familia.");
})();
