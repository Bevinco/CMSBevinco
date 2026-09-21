// Crea, lista y revoca las llaves de API del CMS (las que se le pasan a un
// agente externo para que consulte el sistema).
//
// Uso (PowerShell, desde la carpeta del proyecto):
//   $env:BV_USER="gerencia@bevinco.com"; $env:BV_PASS="<clave>"
//
//   node scripts/llaves-api.js listar
//   node scripts/llaves-api.js crear "Agente de reportes"
//   node scripts/llaves-api.js crear "Agente que edita" --total
//   node scripts/llaves-api.js revocar <id>
//
// La llave se muestra UNA sola vez, al crearla. No queda guardada en claro en
// ninguna parte: si se pierde, se revoca y se crea otra.
// Por defecto la llave es de SOLO LECTURA. --total le permite tambien
// modificar y enviar, asi que se usa solo si el agente realmente lo necesita.

const BASE = process.env.BV_URL || "https://bevinco.onrender.com";
const USER = process.env.BV_USER || "";
const PASS = process.env.BV_PASS || "";
const [accion, ...resto] = process.argv.slice(2);

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
  catch { return { status: res.status, texto: texto.slice(0, 250) }; }
};
const fecha = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");

(async () => {
  if (!USER || !PASS) {
    console.error("Falta BV_USER o BV_PASS. Mira el encabezado de este archivo.");
    process.exit(1);
  }
  if (!accion || !["listar", "crear", "revocar"].includes(accion)) {
    console.error("Acciones: listar | crear \"<nombre>\" [--total] | revocar <id>");
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

  if (accion === "listar") {
    const r = await api("/api/system/api-tokens");
    const llaves = r.json?.tokens || [];
    if (!llaves.length) { console.log("No hay llaves creadas."); return; }
    console.log(`${llaves.length} llave(s):\n`);
    for (const l of llaves) {
      console.log(`  ${l.revokedAt ? "REVOCADA" : "activa  "}  ${l.name}`);
      console.log(`            id ${l.id}`);
      console.log(`            ${l.prefijo} · ${l.scope === "total" ? "acceso total" : "solo lectura"}`);
      console.log(`            creada ${fecha(l.createdAt)} por ${l.createdBy || "—"} · ultimo uso ${fecha(l.lastUsedAt)}\n`);
    }
    return;
  }

  if (accion === "crear") {
    const nombre = resto.filter((x) => !x.startsWith("--")).join(" ").trim();
    if (!nombre) { console.error('Ponle un nombre: node scripts/llaves-api.js crear "Agente de reportes"'); process.exit(1); }
    const scope = resto.includes("--total") ? "total" : "lectura";
    const r = await api("/api/system/api-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: nombre, scope }),
    });
    if (r.status !== 200) { console.error("No se pudo crear:", r.status, JSON.stringify(r.json || r.texto)); process.exit(1); }
    console.log(`\nLlave creada: ${nombre}  (${scope === "total" ? "ACCESO TOTAL" : "solo lectura"})\n`);
    console.log("   " + r.json.token + "\n");
    console.log("   " + r.json.aviso);
    console.log(`   id para revocarla: ${r.json.registro.id}\n`);
    console.log("   Se usa asi:");
    console.log(`   curl -H "Authorization: Bearer ${r.json.token}" ${BASE}/api/module1/bootstrap\n`);
    return;
  }

  const id = resto[0];
  if (!id) { console.error("Indica el id: node scripts/llaves-api.js revocar <id>"); process.exit(1); }
  const r = await api(`/api/system/api-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (r.status !== 200) { console.error("No se pudo revocar:", r.status, JSON.stringify(r.json || r.texto)); process.exit(1); }
  console.log(`Llave revocada (${fecha(r.json.revokedAt)}). Deja de servir de inmediato.`);
})();
