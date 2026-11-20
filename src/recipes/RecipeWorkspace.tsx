import React, { useMemo, useRef, useState } from "react";
import { evaluateRecipes, validateBundle, type RecipeBundle, type EvaluatedLine, type EvaluatedRecipe, type Evaluation } from "../../server/recipes/costing.js";
import { evaluateActualSale, type ActualSales, type EvaluatedSale } from "../../server/recipes/sales.js";
import "./recipes.css";

type Client = { id: string; name: string; cid: string; sculptureCid?: string; accountName?: string; area: string };
const money = (value: number | null) => value === null ? "Pendiente" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const number = (value: number) => new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 }).format(value);
const date = (value: string) => new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Santiago" }).format(new Date(value));
const salesDay = (value: string) => new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
const salesPeriod = (sales: ActualSales) => `${salesDay(sales.startDate)} – ${salesDay(sales.endDate)}`;
const marginNumber = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const formatMargin = (value: number | null) => value === null ? "—" : `${marginNumber.format(value)} %`;
function salesStatus(sale: EvaluatedSale | null | undefined) {
  if (sale?.marginPercent != null) return `${formatMargin(sale.marginPercent)} de margen`;
  return sale?.hasSales === false ? "Sin ventas" : "Margen pendiente";
}

const statusLabel = (recipe: EvaluatedRecipe) => recipe.status === "pending" ? "Costo incompleto" : recipe.provisional ? "Con estimación" : "Costo calculado";

function ActualSale({ sales, sale, recipe }: { sales: ActualSales; sale: EvaluatedSale | null; recipe: EvaluatedRecipe }) {
  return <section className="recipe-options recipe-actual-sale" aria-label="Ventas y margen">
    <h4>Ventas y margen de ingredientes</h4>
    <p>Toteat · {salesPeriod(sales)}</p>
    {!sale ? <p>Falta confirmar el código Toteat de este plato.</p> : !sale.hasSales ? <p>Sin ventas en el período.</p> : <>
      <div><span>Unidades vendidas</span><strong>{number(sale.units)}</strong></div>
      <div><span>Ingreso neto del período</span><strong>{money(sale.netRevenue)}</strong></div>
      <div><span>Ingreso neto promedio por unidad</span><strong>{sale.netPerUnit === null ? "—" : money(sale.netPerUnit)}</strong></div>
      <div><span>Costo de ingredientes del período</span><strong>{money(sale.ingredientCost)}</strong></div>
      <div><span>Contribución tras ingredientes</span><strong>{money(sale.contribution)}</strong></div>
      <div><span>Margen de ingredientes</span><strong>{formatMargin(sale.marginPercent)}</strong></div>
      {sale.options?.length ? <p>{sale.options.map(option => `${option.name} (${number(option.units)})`).join(" · ")}</p> : null}
      {sale.ingredientCost === null ? <p>{recipe.options.length && !sale.options ? "Falta conciliar las opciones vendidas para calcular el margen." : "Faltan costos o equivalencias de la receta para calcular el margen."}</p> : null}
      {sale.ingredientCost !== null && sale.provisional ? <p>El costo incluye estimaciones.</p> : null}
      {sale.ingredientCost !== null && recipe.sides.length ? <p>Costo de guarnición ponderado con el registro del local para el período indicado en la ficha.</p> : null}
      <p>Ingreso sin IVA ni propinas. El margen cubre únicamente ingredientes.</p>
    </>}
  </section>;
}

function Lines({ lines, items, depth = 0 }: { lines: EvaluatedLine[]; items: Record<string, Evaluation>; depth?: number }) {
  return <div className="recipe-table-scroll"><table className="recipe-lines"><thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Costo neto</th><th>Origen del costo</th></tr></thead><tbody>{lines.map((line, index) => <tr key={`${line.itemId}-${index}`}><td>{line.name}{line.issues.map(issue => <small className="recipe-pending-text" key={issue}>{issue}</small>)}{depth < 6 && items[line.itemId]?.lines.length ? <details><summary>Ver ingredientes del lote</summary><Lines lines={items[line.itemId].lines} items={items} depth={depth + 1} /></details> : null}</td><td>{number(line.quantity)} {line.unit}</td><td>{money(line.cost)}{line.cost === null && line.knownCost > 0 ? <small>Subtotal conocido: {money(line.knownCost)}</small> : null}</td><td>{line.source || "Por completar"}{line.provisional ? <small>Estimación provisional</small> : null}</td></tr>)}</tbody></table></div>;
}

export function RecipeWorkspace({ clients, standalone = false, initialBundle }: {
  clients: Client[];
  standalone?: boolean;
  initialBundle?: RecipeBundle;
}) {
  const [clientId, setClientId] = useState("");
  const [bundle, setBundle] = useState<RecipeBundle | null>(() =>
    standalone && initialBundle ? validateBundle(initialBundle) : null,
  );
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const fileRequest = useRef(0);
  const foodClients = clients.filter(client => /cocina|food/i.test(client.area));
  const selectedClient = foodClients.find(client => client.id === clientId);
  const result = useMemo(() => bundle ? evaluateRecipes(bundle) : null, [bundle]);
  const sales = bundle?.actualSales;
  const salesByRecipe = useMemo(() => {
    const rows = new Map(sales?.rows.map(row => [row.recipeId, row]));
    return new Map(result?.recipes.map(recipe => [recipe.id, evaluateActualSale(rows.get(recipe.id), recipe)]));
  }, [result, sales]);
  const recipes = (result?.recipes || []).filter(recipe => {
    const sale = salesByRecipe.get(recipe.id);
    const needsReview = recipe.status === "pending" || (sales && sale?.hasSales !== false && sale?.marginPercent == null);
    return (filter !== "pending" || needsReview) && recipe.name.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es"));
  });
  const selected = recipes.find(recipe => recipe.id === selectedId) || recipes[0];

  async function openFile(file?: File) {
    if (!file) return;
    const request = ++fileRequest.current;
    setError("");
    setBundle(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("El recetario supera 5 MB. Separar por local.");
      const loaded = validateBundle(JSON.parse(await file.text()));
      if (request !== fileRequest.current) return;
      if (!standalone && (!selectedClient || loaded.scope.clientId !== String(selectedClient.sculptureCid || selectedClient.cid) || loaded.scope.account.trim().toLowerCase() !== selectedClient.accountName?.trim().toLowerCase())) {
        throw new Error("El archivo no corresponde al local y cuenta seleccionados.");
      }
      evaluateRecipes(loaded);
      setSelectedId(""); setFilter("all"); setSearch(""); setBundle(loaded);
    } catch (issue) { if (request === fileRequest.current) setError(issue instanceof Error ? issue.message : "No se pudo abrir el recetario."); }
  }

  return <section className="recipe-workspace">
    <div className="recipe-heading"><div><p className="recipe-eyebrow">Cocina · revisión del piloto</p><h2>Recetario, costos y márgenes</h2></div><span className="recipe-stage">En revisión</span></div>
    <div className="recipe-controls">
      {!standalone ? <label>Local<select value={clientId} onChange={event => { fileRequest.current++; setClientId(event.target.value); setBundle(null); setError(""); }}><option value="">Seleccionar cocina</option>{foodClients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label> : null}
      <label className="recipe-open">Abrir recetario preparado<input type="file" accept="application/json,.json" disabled={!standalone && !selectedClient} onChange={event => { void openFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
    </div>
    {error ? <p role="alert" className="recipe-error">{error}</p> : null}
    {!result ? <div className="recipe-empty"><h3>Abre el recetario del local</h3><p>Selecciona el archivo preparado para revisar las fichas, los costos y las ventas del período.</p></div> : <>
      <div className="recipe-source"><strong>{bundle?.clientName || selectedClient?.name || "Recetario del local"}</strong><span>Corte de lectura de costos · {date(result.sourceReadAt)}</span>{sales ? <span>Ventas Toteat · {salesPeriod(sales)}</span> : null}</div>
      <div className="recipe-summary"><div><strong>{result.counts.total}</strong><span>Recetas del piloto</span></div><div><strong>{result.counts.calculated}</strong><span>Con costo calculado</span></div><div><strong>{result.counts.pending}</strong><span>Con datos pendientes</span></div><div><strong>{sales ? [...salesByRecipe.values()].filter(sale => sale?.marginPercent != null).length : result.counts.provisional}</strong><span>{sales ? "Margen calculado" : "Incluyen estimaciones"}</span></div></div>
      <div className="recipe-filter"><label>Buscar plato<input placeholder="Nombre del plato" value={search} onChange={event => setSearch(event.target.value)} /></label><label>Mostrar<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Todos los platos</option><option value="pending">Con datos pendientes</option></select></label></div>
      <div className="recipe-layout"><nav className="recipe-list" aria-label="Platos">{recipes.length ? recipes.map(recipe => <button className={selected?.id === recipe.id ? "selected" : ""} onClick={() => setSelectedId(recipe.id)} key={recipe.id}><span>{recipe.name}</span><small className={`recipe-status ${recipe.status}`}>{statusLabel(recipe)}</small><strong>{sales ? salesStatus(salesByRecipe.get(recipe.id)) : recipe.status === "pending" ? "Total pendiente" : money(recipe.totalCost)}</strong></button>) : <p>No hay platos con este filtro.</p>}</nav>
      {selected ? <article className="recipe-detail"><div className="recipe-detail-heading"><div><h3>{selected.name}</h3><span className={`recipe-status ${selected.status}`}>{statusLabel(selected)}</span></div><div className="recipe-total"><span>{selected.sides.length ? "Costo con guarnición ponderada" : selected.options.length ? "Costo de receta base" : "Costo por porción"}</span><strong>{money(selected.totalCost)}</strong>{selected.status === "pending" ? <small>Subtotal conocido: {money(selected.knownCost)}. No es el costo total.</small> : null}</div></div>
        {sales ? <ActualSale sales={sales} sale={salesByRecipe.get(selected.id) ?? null} recipe={selected} /> : null}
        {selected.issues.length ? <div className="recipe-pending-box"><strong>Datos por completar</strong><ul>{selected.issues.map(issue => <li key={issue}>{issue}</li>)}</ul><p>El faltante se conserva como pendiente; no se reemplaza por cero.</p></div> : null}
        <Lines lines={selected.lines} items={result.items} />
        {selected.sides.length ? <section className="recipe-options"><h4>Una guarnición incluida</h4><p>Frecuencias de {result.salesPeriod}. Mezcla agregada del local. El cálculo excluye adicionales pagados.</p>{selected.sides.map(side => <div key={side.itemId}><span>{side.name}<small>{number(side.count)} elecciones · {side.weight === null ? "Sin frecuencia" : `${number(side.weight * 100)} %`}</small></span><strong>{money(side.combinedCost)}</strong></div>)}<div><span>Guarnición ponderada</span><strong>{money(selected.weightedSideCost)}</strong></div></section> : null}
        {selected.options.length ? <section className="recipe-options"><h4>Opciones alternativas</h4>{selected.options.map(option => <div key={option.name}><span>{option.name}<small>Costo de receta base más esta opción</small></span><strong>{money(option.cost)}</strong></div>)}</section> : null}
        {selected.saleNet !== null ? <section className="recipe-options"><h4>Referencia de venta neta</h4><div><span>Venta neta</span><strong>{money(selected.saleNet)}</strong></div><div><span>Costo de ingredientes</span><strong>{selected.ingredientCostPercent === null ? "Pendiente" : `${number(selected.ingredientCostPercent)} %`}</strong></div><div><span>Contribución tras ingredientes</span><strong>{money(selected.contribution)}</strong></div><p>La contribución cubre ingredientes. Las opciones alternativas se revisan por separado.</p></section> : !sales ? <p className="recipe-footnote">Carga un archivo con ventas Toteat para calcular el margen del período.</p> : null}
        {selected.notes.length ? <details className="recipe-notes"><summary>Acuerdos y observaciones de cocina</summary><ul>{selected.notes.map(note => <li key={note}>{note}</li>)}</ul></details> : null}
      </article> : null}</div>
      <p className="recipe-footnote">Costos teóricos de ingredientes para revisión. Los datos importados se conservan mientras esta vista está abierta.</p>
    </>}
  </section>;
}
