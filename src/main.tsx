import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  BarChart3,
  Bell,
  Bot,
  CheckCircle2,
  ClipboardList,
  Cloud,
  Database,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  ListChecks,
  Lock,
  LogOut,
  Mail,
  PencilLine,
  Printer,
  RefreshCw,
  Send,
  ShieldCheck,
  ShoppingCart,
  Workflow,
} from "lucide-react";
import "./styles.css";

type ReportStatus = "Borrador" | "Listo para revisar" | "Enviado";
type AuthStatus = "checking" | "authenticated" | "anonymous";
type WorkStatus = "idle" | "loading" | "ready" | "error";
type ActiveView = "dashboard" | "module1" | "reports" | "criteria" | "integrations" | "future";

type Client = {
  id: string;
  name: string;
  cid: string;
  area: string;
  recipients: string[];
};

type Period = {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
};

type HistoryPoint = {
  periodId: string;
  label: string;
  revenue: number;
  costPercent: number;
  varianceAmount: number;
};

type Report = {
  id: string;
  clientId: string;
  periodId: string;
  status: ReportStatus;
  updatedAt: string;
  client?: Client;
  period?: Period;
  history: HistoryPoint[];
  summary: {
    revenue: number;
    costPercent: number;
    variancePercent: number;
    varianceAmount: number;
  };
  categoryVariances: Array<{ category: string; amount: number; percent: number }>;
  topProducts: Array<{ name: string; category: string; varianceAmount: number; variancePercent: number }>;
  purchaseSuggestions: Array<{ item: string; provider: string; stock: string; suggested: string; note: string }>;
  comments: string;
  emailDraft: string;
  sourceStatus: Record<string, string>;
};

type BootstrapPayload = {
  clients: Client[];
  periods: Period[];
  reports: Report[];
  selectedReport: Report | null;
};

const moduleRoadmap = [
  {
    number: "01",
    title: "Reportes Bevinco",
    status: "MVP activo",
    description: "Automatiza el reporte semanal que hoy se descarga de Sculpture, se pega en Excel y se comenta manualmente.",
    items: ["Variance detailed y summary", "Intelipar", "Historico 4 periodos", "PDF y email"],
  },
  {
    number: "02",
    title: "Clientes y criterios",
    status: "Base inicial",
    description: "Define reglas por cliente para mantener criterio operativo sin perder flexibilidad.",
    items: ["Clientes", "Categorias", "Reglas", "Formatos"],
  },
  {
    number: "03",
    title: "Comunicaciones",
    status: "En preparacion",
    description: "Centraliza avisos, destinatarios y seguimiento de reportes enviados.",
    items: ["Emails", "Destinatarios", "Seguimiento", "Historial"],
  },
  {
    number: "04",
    title: "Reservas y pagos",
    status: "Futuro",
    description: "Gestiona reservas, proveedores, codigos, pasajeros, vencimientos y alertas visuales.",
    items: ["Reservas", "Pagos", "Alertas", "Proveedores"],
  },
];

const reportWorkflow = [
  {
    icon: Database,
    title: "Sincronizar datos",
    detail: "Traer datos semanales desde Sculpture por cliente, periodo y tipo de reporte.",
  },
  {
    icon: BarChart3,
    title: "Variance Report",
    detail: "Leer food cost / pour cost, variaciones por producto y resumen por categoria.",
  },
  {
    icon: ShoppingCart,
    title: "Intelipar",
    detail: "Obtener sugerencia de compra y revisar proveedores o datos desactualizados.",
  },
  {
    icon: Bot,
    title: "Dashboard semanal",
    detail: "Mantener graficos consistentes con comparacion de los ultimos cuatro periodos.",
  },
  {
    icon: Send,
    title: "Revision y envio",
    detail: "Editar comentarios, preparar correo, PDF adjunto y registro de estado.",
  },
];

const moduleOneProcess = [
  {
    title: "1. Auditoria semanal",
    detail: "El cliente o equipo Bevinco toma inventario en Sculpture y se cierra el periodo semanal.",
    status: "Origen",
  },
  {
    title: "2. Variance Report",
    detail: "Se obtiene el detalle y resumen de diferencias, ingresos, costo real e ideal.",
    status: "Datos cargados",
  },
  {
    title: "3. Intelipar",
    detail: "Se revisa sugerencia de compra, stock, par, orden, proveedor y excesos.",
    status: "Datos cargados",
  },
  {
    title: "4. Reporte Bevinco",
    detail: "Se arma el resumen semanal con historico de 4 periodos, categorias y top productos.",
    status: "En CMS",
  },
  {
    title: "5. Revision humana",
    detail: "Se editan comentarios, se validan proveedores y se marca como listo para revisar.",
    status: "En CMS",
  },
  {
    title: "6. Envio al cliente",
    detail: "Se exporta PDF y se prepara email con registro de estado enviado.",
    status: "Preparado",
  },
];

const moduleOneChecklist = [
  {
    title: "Datos semanales cargados",
    detail: "Variance e Intelipar ya alimentan el reporte seleccionado.",
    status: "Listo",
  },
  {
    title: "Cliente y periodo seleccionados",
    detail: "El equipo puede cambiar entre clientes, barra/cocina y semana auditada.",
    status: "Listo",
  },
  {
    title: "Comentarios revisables",
    detail: "El comentario ejecutivo queda editable antes del envio.",
    status: "Listo",
  },
  {
    title: "PDF preparado",
    detail: "El reporte se puede abrir e imprimir como PDF con formato ejecutivo.",
    status: "Listo",
  },
  {
    title: "Envio al cliente",
    detail: "El equipo prepara el email y registra el estado del reporte.",
    status: "Preparado",
  },
  {
    title: "Validacion de proveedores",
    detail: "Las sugerencias de compra quedan visibles para revisar proveedor, stock y orden antes del envio.",
    status: "Por revisar",
  },
];

function taskStatusClass(status: string) {
  if (status === "Por revisar") return "task-status pending";
  if (status === "En curso") return "task-status working";
  if (status === "Preparado") return "task-status prepared";
  return "task-status done";
}

const criteria = [
  "Comparar ventas, inventario y compras por categoria.",
  "Mantener comparacion de los ultimos cuatro periodos.",
  "Marcar proveedores desactualizados antes de sugerir compras.",
  "Mantener comentarios editables antes del envio.",
  "Respetar el formato historico de graficos y resumen semanal.",
];

const sourceLabels: Record<string, string> = {
  varianceDetailed: "Variance detailed",
  varianceSummary: "Variance summary",
  intelipar: "Intelipar",
};

function money(value: number) {
  return new Intl.NumberFormat("es-CL", {
    currency: "CLP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value || 0);
}

function statusClass(status: ReportStatus) {
  if (status === "Enviado") return "pill success";
  if (status === "Listo para revisar") return "pill warning";
  return "pill neutral";
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || payload.message || "La solicitud fallo.");
  }
  return payload;
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      await readJson(
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        }),
      );
      onLogin();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Error desconocido.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand login-brand">
          <div className="brand-mark">B</div>
          <div>
            <strong>Bevinco CMS</strong>
            <span>Acceso interno</span>
          </div>
        </div>
        <div>
          <p className="eyebrow">Modulo 1</p>
          <h1>Reportes automatizados Bevinco</h1>
        </div>
        <form className="login-form" onSubmit={submitLogin}>
          <label>
            Usuario
            <input autoComplete="username" onChange={(event) => setUsername(event.target.value)} required type="text" value={username} />
          </label>
          <label>
            Contrasena
            <input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          </label>
          {error ? <p className="login-error">{error}</p> : null}
          <button className="primary-button" disabled={submitting} type="submit">
            <Lock size={17} /> {submitting ? "Entrando" : "Entrar"}
          </button>
        </form>
      </section>
    </main>
  );
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [currentUser, setCurrentUser] = useState("");
  const [workStatus, setWorkStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [commentsDraft, setCommentsDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [activeView, setActiveView] = useState<ActiveView>("module1");
  const [csvSourceType, setCsvSourceType] = useState("auto");
  const [selectedCsvFiles, setSelectedCsvFiles] = useState<File[]>([]);

  async function checkSession() {
    try {
      const payload = await readJson<{ authenticated: boolean; user: { username: string } | null }>(
        await fetch("/api/auth/me"),
      );

      if (payload.authenticated) {
        setCurrentUser(payload.user?.username || "");
        setAuthStatus("authenticated");
        return;
      }
    } catch {
      setCurrentUser("");
    }

    setAuthStatus("anonymous");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setCurrentUser("");
    setAuthStatus("anonymous");
    setSelectedReport(null);
  }

  function applyBootstrapPayload(payload: BootstrapPayload) {
    setClients(payload.clients);
    setPeriods(payload.periods);
    setReports(payload.reports);
    const report = payload.selectedReport;
    setSelectedReport(report);
    setSelectedClientId(report?.clientId || payload.clients[0]?.id || "");
    setSelectedPeriodId(report?.periodId || payload.periods[0]?.id || "");
    setCommentsDraft(report?.comments || "");
    setEmailDraft(report?.emailDraft || "");
  }

  async function loadModule() {
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<BootstrapPayload>(await fetch("/api/module1/bootstrap"));
      applyBootstrapPayload(payload);
      setWorkStatus("ready");
    } catch (moduleError) {
      setError(moduleError instanceof Error ? moduleError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function importSamples() {
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<BootstrapPayload>(
        await fetch("/api/module1/import-samples", { method: "POST" }),
      );
      applyBootstrapPayload(payload);
      setWorkStatus("ready");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function importCsvFiles(files = selectedCsvFiles) {
    if (!files.length || !selectedClientId || !selectedPeriodId) return;
    setWorkStatus("loading");
    setError("");

    try {
      const encodedFiles = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          csvText: await file.text(),
        })),
      );
      const payload = await readJson<BootstrapPayload & { imported?: Array<{ fileName: string; sourceType: string; rows: number }> }>(
        await fetch("/api/module1/import-csv", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: selectedClientId,
            periodId: selectedPeriodId,
            sourceType: csvSourceType,
            files: encodedFiles,
          }),
        }),
      );
      applyBootstrapPayload(payload);
      const importedText = payload.imported
        ?.map((item) => `${item.fileName}: ${sourceLabels[item.sourceType] || item.sourceType} (${item.rows} filas)`)
        .join(" | ");
      setError(importedText ? `Datos importados: ${importedText}` : "");
      setSelectedCsvFiles([]);
      setWorkStatus("ready");
    } catch (csvError) {
      setError(csvError instanceof Error ? csvError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function loadSelectedReport(clientId = selectedClientId, periodId = selectedPeriodId) {
    if (!clientId || !periodId) return;
    setWorkStatus("loading");
    setError("");

    try {
      const report = await readJson<Report>(
        await fetch(`/api/module1/reports/current?clientId=${encodeURIComponent(clientId)}&periodId=${encodeURIComponent(periodId)}`),
      );
      setSelectedReport(report);
      setCommentsDraft(report.comments || "");
      setEmailDraft(report.emailDraft || "");
      setReports((current) => {
        const exists = current.some((item) => item.id === report.id);
        return exists ? current.map((item) => (item.id === report.id ? report : item)) : [report, ...current];
      });
      setWorkStatus("ready");
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function syncReport() {
    if (!selectedReport) return;
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<{ report: Report }>(
        await fetch("/api/module1/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: selectedReport.clientId, periodId: selectedReport.periodId }),
        }),
      );
      setSelectedReport(payload.report);
      setCommentsDraft(payload.report.comments || "");
      setEmailDraft(payload.report.emailDraft || "");
      setReports((current) => current.map((item) => (item.id === payload.report.id ? payload.report : item)));
      setWorkStatus("ready");
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function saveReport(patch: Partial<Report>) {
    if (!selectedReport) return;

    const updated = await readJson<Report>(
      await fetch(`/api/module1/reports/${selectedReport.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );

    setSelectedReport(updated);
    setReports((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    if (patch.comments !== undefined) setCommentsDraft(updated.comments || "");
    if (patch.emailDraft !== undefined) setEmailDraft(updated.emailDraft || "");
  }

  async function generateSummary() {
    if (!selectedReport) return;
    setWorkStatus("loading");
    setError("");

    try {
      const updated = await readJson<Report>(
        await fetch(`/api/module1/reports/${selectedReport.id}/summary`, { method: "POST" }),
      );
      setSelectedReport(updated);
      setReports((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setCommentsDraft(updated.comments || "");
      setEmailDraft(updated.emailDraft || "");
      setError("Resumen ejecutivo generado con los datos cargados del reporte.");
      setWorkStatus("ready");
    } catch (summaryError) {
      setError(summaryError instanceof Error ? summaryError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function sendEmail() {
    if (!selectedReport) return;
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<{ report?: Report; message?: string }>(
        await fetch(`/api/module1/reports/${selectedReport.id}/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipients: selectedReport.client?.recipients || [] }),
        }),
      );
      if (payload.report) {
        setSelectedReport(payload.report);
        setReports((current) => current.map((item) => (item.id === payload.report?.id ? payload.report : item)));
      }
      setError(payload.message || "");
      setWorkStatus("ready");
    } catch (emailError) {
      setError(emailError instanceof Error ? emailError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  useEffect(() => {
    checkSession();
  }, []);

  useEffect(() => {
    if (authStatus === "authenticated") loadModule();
  }, [authStatus]);

  const reportRows = useMemo(() => reports.slice(0, 8), [reports]);
  const maxRevenue = Math.max(...(selectedReport?.history.map((item) => item.revenue) || [1]), 1);
  const maxAbsVariance = Math.max(...(selectedReport?.history.map((item) => Math.abs(item.varianceAmount)) || [1]), 1);
  const viewMeta = {
    dashboard: ["CMS modular", "Inicio"],
    module1: ["Modulo operativo", "Modulo 1: reportes automatizados Bevinco"],
    reports: ["Bandeja", "Reportes guardados"],
    criteria: ["Base reusable", "Criterios de auditoria"],
    integrations: ["Configuracion", "Integraciones"],
    future: ["Proximos modulos", "Operaciones futuras"],
  }[activeView];

  if (authStatus === "checking") {
    return (
      <main className="loading-shell">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <strong>Bevinco CMS</strong>
            <span>Validando sesion</span>
          </div>
        </div>
      </main>
    );
  }

  if (authStatus === "anonymous") return <LoginScreen onLogin={checkSession} />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <strong>Bevinco CMS</strong>
            <span>Reportes y operaciones</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Modulos">
          <button className={activeView === "dashboard" ? "active" : ""} onClick={() => setActiveView("dashboard")}><LayoutDashboard size={18} /> Inicio</button>
          <button className={activeView === "module1" ? "active" : ""} onClick={() => setActiveView("module1")}><ClipboardList size={18} /> Modulo 1</button>
          <button className={activeView === "reports" ? "active" : ""} onClick={() => setActiveView("reports")}><FileText size={18} /> Reportes</button>
          <button className={activeView === "criteria" ? "active" : ""} onClick={() => setActiveView("criteria")}><ShieldCheck size={18} /> Criterios</button>
          <button className={activeView === "integrations" ? "active" : ""} onClick={() => setActiveView("integrations")}><Cloud size={18} /> Integraciones</button>
          <button className={activeView === "future" ? "active" : ""} onClick={() => setActiveView("future")}><Workflow size={18} /> Proximos</button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar" id="dashboard">
          <div>
            <p className="eyebrow">{viewMeta[0]}</p>
            <h1>{viewMeta[1]}</h1>
          </div>
          <div className="topbar-actions">
            <span>{currentUser}</span>
            <button className="secondary-button" onClick={logout}><LogOut size={17} /> Salir</button>
          </div>
        </header>

        {activeView === "dashboard" ? (
          <>
            <section className="module-roadmap" aria-label="Modulos del CMS">
              {moduleRoadmap.map((module) => (
                <button
                  className="module-card module-card-button"
                  key={module.number}
                  onClick={() => setActiveView(module.number === "01" ? "module1" : module.number === "02" ? "criteria" : module.number === "03" ? "integrations" : "future")}
                >
                  <div className="module-card-top">
                    <span>{module.number}</span>
                    <small>{module.status}</small>
                  </div>
                  <h2>{module.title}</h2>
                  <p>{module.description}</p>
                  <div className="module-tags">
                    {module.items.map((item) => <span key={item}>{item}</span>)}
                  </div>
                </button>
              ))}
            </section>
            <section className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Modulo activo</p>
                  <h2>Reportes Bevinco/Sculpture</h2>
                </div>
                <button className="primary-button" onClick={() => setActiveView("module1")}><ClipboardList size={17} /> Abrir modulo</button>
              </div>
            </section>
          </>
        ) : null}

        {activeView === "module1" ? (
          <>
        <section className="control-bar">
          <label>
            Cliente
            <select
              value={selectedClientId}
              onChange={(event) => {
                setSelectedClientId(event.target.value);
                loadSelectedReport(event.target.value, selectedPeriodId);
              }}
            >
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
          </label>
          <label>
            Periodo
            <select
              value={selectedPeriodId}
              onChange={(event) => {
                setSelectedPeriodId(event.target.value);
                loadSelectedReport(selectedClientId, event.target.value);
              }}
            >
              {periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
            </select>
          </label>
          <button className="primary-button" disabled={!selectedReport || workStatus === "loading"} onClick={syncReport}>
            <RefreshCw size={17} /> Sincronizar fuentes
          </button>
          <button className="secondary-button" disabled={workStatus === "loading"} onClick={importSamples}>
            <Database size={17} /> Restaurar Bardot
          </button>
          {selectedReport ? (
            <a className="button-link" href={`/api/module1/reports/${selectedReport.id}/export`} target="_blank" rel="noreferrer">
              <Printer size={17} /> Exportar PDF
            </a>
          ) : null}
        </section>

        {error ? <p className="connector-error">{error}</p> : null}

        <section className="metrics" aria-label="Resumen">
          <article>
            <span><FileSpreadsheet size={18} /> Ingresos</span>
            <strong>{money(selectedReport?.summary.revenue || 0)}</strong>
            <small>{selectedReport?.period?.label || "Sin periodo"}</small>
          </article>
          <article>
            <span><BarChart3 size={18} /> % costo</span>
            <strong>{selectedReport?.summary.costPercent || 0}%</strong>
            <small>Food cost / pour cost</small>
          </article>
          <article>
            <span><FileText size={18} /> Variance</span>
            <strong>{selectedReport?.summary.variancePercent || 0}%</strong>
            <small>{money(selectedReport?.summary.varianceAmount || 0)}</small>
          </article>
          <article>
            <span><ListChecks size={18} /> Estado</span>
            <strong className="metric-status">{selectedReport?.status || "Borrador"}</strong>
            <small>{workStatus === "loading" ? "Actualizando" : "Operativo"}</small>
          </article>
        </section>

        <section className="panel module-one" id="module-reports">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Flujo completo</p>
              <h2>Reportes Bevinco/Sculpture</h2>
            </div>
            <span className={statusClass(selectedReport?.status || "Borrador")}>{selectedReport?.status || "Borrador"}</span>
          </div>
          <div className="workflow-list">
            {reportWorkflow.map((step) => {
              const Icon = step.icon;
              return (
                <article key={step.title}>
                  <Icon size={20} />
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.detail}</small>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="module-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Lo que debe reflejar</p>
                <h2>Proceso semanal real</h2>
              </div>
              <Workflow size={22} />
            </div>
            <div className="process-list">
              {moduleOneProcess.map((step) => (
                <article key={step.title}>
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.detail}</small>
                  </div>
                  <span className={taskStatusClass(step.status)}>{step.status}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Checklist</p>
                <h2>Preparacion del reporte</h2>
              </div>
              <ListChecks size={22} />
            </div>
            <div className="pending-list">
              {moduleOneChecklist.map((item) => (
                <article key={item.title}>
                  <span className={taskStatusClass(item.status)}>{item.status}</span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="module-grid" id="sources">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Fuentes Sculpture</p>
                <h2>Conectores del modulo 1</h2>
              </div>
              <Cloud size={22} />
            </div>
            <div className="source-grid">
              {Object.entries(sourceLabels).map(([key, label]) => (
                <article key={key}>
                  <strong>{label}</strong>
                  <span className={["Sincronizado", "Datos cargados"].includes(selectedReport?.sourceStatus[key] || "") ? "pill success" : "pill neutral"}>
                    {selectedReport?.sourceStatus[key] || "Por revisar"}
                  </span>
                </article>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Importar datos</p>
                <h2>Reportes descargados</h2>
              </div>
              <FileSpreadsheet size={22} />
            </div>
            <div className="upload-box">
              <label>
                Fuente
                <select value={csvSourceType} onChange={(event) => setCsvSourceType(event.target.value)}>
                  <option value="auto">Detectar automaticamente</option>
                  <option value="varianceDetailed">Variance detailed</option>
                  <option value="varianceSummary">Variance summary</option>
                  <option value="intelipar">Intelipar</option>
                </select>
              </label>
              <label>
                Archivo
                <input
                  accept=".csv,text/csv"
                  multiple
                  type="file"
                  onChange={(event) => setSelectedCsvFiles(Array.from(event.target.files || []))}
                />
              </label>
              {selectedCsvFiles.length ? (
                <div className="selected-files">
                  {selectedCsvFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
                </div>
              ) : (
                <small>Selecciona uno o varios CSV descargados del sistema de auditoria.</small>
              )}
              <div className="upload-actions">
                <button
                  className="primary-button"
                  disabled={!selectedCsvFiles.length || workStatus === "loading"}
                  onClick={() => importCsvFiles()}
                >
                  <FileSpreadsheet size={17} /> Cargar datos al reporte
                </button>
                <button
                  className="secondary-button"
                  disabled={!selectedCsvFiles.length || workStatus === "loading"}
                  onClick={() => setSelectedCsvFiles([])}
                >
                  Limpiar seleccion
                </button>
              </div>
              <small>Al cargar, el CMS detecta la fuente, recalcula el resumen y actualiza el reporte seleccionado.</small>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Acciones</p>
              <h2>Revision y envio</h2>
            </div>
            <Mail size={22} />
          </div>
          <div className="action-row wrap-actions">
            <button className="secondary-button" onClick={() => selectedReport && saveReport({ status: "Borrador" })}>Marcar borrador</button>
            <button className="secondary-button" onClick={() => selectedReport && saveReport({ status: "Listo para revisar" })}>Listo para revisar</button>
            <button className="primary-button" onClick={sendEmail}><Send size={17} /> Preparar/enviar email</button>
          </div>
        </section>

        <section className="split-section">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Historico</p>
                <h2>Ultimos 4 periodos</h2>
              </div>
              <BarChart3 size={22} />
            </div>
            <div className="history-chart">
              {selectedReport?.history.map((point) => (
                <article key={point.periodId}>
                  <span>{point.label}</span>
                  <div className="bar-track"><div style={{ width: `${Math.max(8, (point.revenue / maxRevenue) * 100)}%` }} /></div>
                  <small>{money(point.revenue)} - {point.costPercent}% costo</small>
                  <div className="bar-track variance"><div style={{ width: `${Math.max(8, (Math.abs(point.varianceAmount) / maxAbsVariance) * 100)}%` }} /></div>
                  <small>{money(point.varianceAmount)} variance</small>
                </article>
              ))}
            </div>
          </div>

          <div className="panel" id="comments">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Editable</p>
                <h2>Resumen ejecutivo del reporte</h2>
              </div>
              <Bot size={22} />
            </div>
            <div className="summary-help">
              <strong>Agente de resumen</strong>
              <small>Genera un analisis editable usando ingresos, costo, variance, categorias, top productos e Intelipar del CSV cargado.</small>
            </div>
            <textarea aria-label="Resumen ejecutivo" value={commentsDraft} onChange={(event) => setCommentsDraft(event.target.value)} />
            <textarea aria-label="Cuerpo del email" value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} />
            <div className="action-row wrap-actions">
              <button className="secondary-button" disabled={!selectedReport || workStatus === "loading"} onClick={generateSummary}>
                <Bot size={17} /> Generar resumen del reporte
              </button>
              <button className="primary-button" onClick={() => saveReport({ comments: commentsDraft, emailDraft })}>
                <PencilLine size={17} /> Guardar resumen y email
              </button>
            </div>
          </div>
        </section>

        <section className="module-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Variance</p>
                <h2>Variaciones por categoria</h2>
              </div>
            </div>
            <div className="table compact-table">
              <div className="table-row table-head"><span>Categoria</span><span>Monto</span><span>%</span></div>
              {selectedReport?.categoryVariances.map((item) => (
                <div className="table-row" key={item.category}><span>{item.category}</span><span>{money(item.amount)}</span><span>{item.percent}%</span></div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Productos</p>
                <h2>Top variaciones</h2>
              </div>
            </div>
            <div className="product-list">
              {selectedReport?.topProducts.map((item) => (
                <article key={`${item.name}-${item.category}`}>
                  <strong>{item.name}</strong>
                  <small>{item.category} - {money(item.varianceAmount)} - {item.variancePercent}%</small>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Intelipar</p>
              <h2>Sugerencia de compra</h2>
            </div>
            <ShoppingCart size={22} />
          </div>
          <div className="purchase-grid">
            {selectedReport?.purchaseSuggestions.map((item) => (
              <article key={`${item.item}-${item.provider}`}>
                <strong>{item.item}</strong>
                <span>{item.provider}</span>
                <small>Stock {item.stock} - sugerido {item.suggested}</small>
                <p>{item.note}</p>
              </article>
            ))}
          </div>
        </section>
          </>
        ) : null}

        {activeView === "reports" ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Bandeja</p>
              <h2>Reportes guardados</h2>
            </div>
            <ClipboardList size={22} />
          </div>
          <div className="report-list">
            {reportRows.map((report) => (
              <button
                key={report.id}
                onClick={() => {
                  setSelectedClientId(report.clientId);
                  setSelectedPeriodId(report.periodId);
                  setSelectedReport(report);
                  setCommentsDraft(report.comments || "");
                  setEmailDraft(report.emailDraft || "");
                  setActiveView("module1");
                }}
              >
                <span>
                  <strong>{report.client?.name || report.clientId}</strong>
                  <small>{report.period?.label || report.periodId}</small>
                </span>
                <span className={statusClass(report.status)}>{report.status}</span>
              </button>
            ))}
          </div>
        </section>
        ) : null}

        {activeView === "criteria" ? (
        <section className="page-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Base reusable</p>
                <h2>Criterios de auditoria</h2>
              </div>
              <ShieldCheck size={22} />
            </div>
            <ul className="criteria-list">
              {criteria.map((item) => <li key={item}><CheckCircle2 size={18} /> {item}</li>)}
            </ul>
          </div>
        </section>
        ) : null}

        {activeView === "integrations" ? (
        <section className="page-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Fuentes y servicios</p>
                <h2>Integraciones</h2>
              </div>
              <Cloud size={22} />
            </div>
            <div className="source-grid">
              {Object.entries(sourceLabels).map(([key, label]) => (
                <article key={key}>
                  <strong>{label}</strong>
                  <span className={["Sincronizado", "Datos cargados"].includes(selectedReport?.sourceStatus[key] || "") ? "pill success" : "pill neutral"}>
                    {selectedReport?.sourceStatus[key] || "Por revisar"}
                  </span>
                </article>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Operacion</p>
                <h2>Flujo del equipo</h2>
              </div>
              <Database size={22} />
            </div>
            <div className="mini-roadmap">
              <article><span>DA</span><div><strong>Datos</strong><small>Reportes semanales por cliente y periodo</small></div></article>
              <article><span>RE</span><div><strong>Revision</strong><small>Comentarios y proveedores validados por el equipo</small></div></article>
              <article><span>EN</span><div><strong>Envio</strong><small>PDF y email preparados para el cliente</small></div></article>
              <article><span>HI</span><div><strong>Historial</strong><small>Seguimiento de estados y periodos anteriores</small></div></article>
            </div>
          </div>
        </section>
        ) : null}

        {activeView === "future" ? (
        <section className="page-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Proximos pasos</p>
                <h2>Operaciones futuras</h2>
              </div>
              <Workflow size={22} />
            </div>
            <div className="mini-roadmap">
              {moduleRoadmap.map((module) => (
                <article key={module.number}>
                  <span>{module.number}</span>
                  <div>
                    <strong>{module.title}</strong>
                    <small>{module.status}</small>
                  </div>
                </article>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Modulo futuro</p>
                <h2>Reservas y pagos</h2>
              </div>
              <Bell size={22} />
            </div>
            <p className="muted-copy">Queda separado del modulo 1. Se activara cuando pasemos al flujo de reservas, proveedores, vencimientos y alertas.</p>
          </div>
        </section>
        ) : null}
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
