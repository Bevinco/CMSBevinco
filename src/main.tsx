import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  BarChart3,
  Bot,
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
  Trash2,
  Upload,
  ShoppingCart,
  Workflow,
} from "lucide-react";
import "./styles.css";

type ReportStatus = "Borrador" | "Listo para revisar" | "Enviado";
type AuthStatus = "checking" | "authenticated" | "anonymous";
type WorkStatus = "idle" | "loading" | "ready" | "error";
type ActiveView = "dashboard" | "module1" | "reports" | "criteria";

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
  analysis?: {
    bestOfWeek?: string[];
    weeklyChallenges?: string[];
    stockEfficiency?: string[];
    criteriaApplied?: string[];
    agentNotes?: string[];
  };
  comments: string;
  emailDraft: string;
  sourceStatus: Record<string, string>;
};

type CriteriaDocument = {
  id: string;
  name: string;
  type: string;
  text: string;
  size: number;
  uploadedAt: string;
};

type BootstrapPayload = {
  clients: Client[];
  periods: Period[];
  criteriaDocuments: CriteriaDocument[];
  reports: Report[];
  selectedReport: Report | null;
};

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
  const rawPayload = await response.text();
  let payload: { error?: string; message?: string } = {};

  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = { error: rawPayload.slice(0, 240) };
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || payload.message || "La solicitud fallo.");
  }
  return payload as T;
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
  const [criteriaDocuments, setCriteriaDocuments] = useState<CriteriaDocument[]>([]);
  const [selectedCriteriaFiles, setSelectedCriteriaFiles] = useState<File[]>([]);

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
    setCriteriaDocuments(payload.criteriaDocuments || []);
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
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > 10 * 1024 * 1024) {
      setError("La carga supera 10 MB. Sube solo CSV descargados desde Sculpture o divide los archivos.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Leyendo CSV y actualizando el reporte...");
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30000);

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
          signal: controller.signal,
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
      setError(
        csvError instanceof DOMException && csvError.name === "AbortError"
          ? "La carga demoró demasiado y fue cancelada. Intenta con un CSV a la vez."
          : csvError instanceof Error
            ? csvError.message
            : "Error desconocido.",
      );
      setWorkStatus("error");
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function importCriteriaFiles(files = selectedCriteriaFiles) {
    if (!files.length) return;
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > 5 * 1024 * 1024) {
      setError("La carga de criterios supera 5 MB. Sube documentos mas pequenos o divididos por tema.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Leyendo criterios para alimentar el agente de reportes...");

    try {
      const encodedFiles = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "text/plain",
          size: file.size,
          text: await file.text(),
        })),
      );
      const payload = await readJson<BootstrapPayload>(
        await fetch("/api/module1/criteria-documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ files: encodedFiles }),
        }),
      );
      applyBootstrapPayload(payload);
      setSelectedCriteriaFiles([]);
      setError("Criterios cargados. El agente los tomara en cuenta al generar los reportes.");
      setWorkStatus("ready");
    } catch (criteriaError) {
      setError(criteriaError instanceof Error ? criteriaError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function deleteCriteriaDocument(documentId: string) {
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<BootstrapPayload>(
        await fetch(`/api/module1/criteria-documents/${documentId}`, { method: "DELETE" }),
      );
      applyBootstrapPayload(payload);
      setError("Criterio eliminado. El agente recalculara el analisis con la biblioteca actual.");
      setWorkStatus("ready");
    } catch (criteriaError) {
      setError(criteriaError instanceof Error ? criteriaError.message : "Error desconocido.");
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
      setError("Reporte generado y guardado. Puedes abrirlo desde la bandeja de Reportes.");
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
  const maxCategoryVariance = Math.max(...(selectedReport?.categoryVariances.map((item) => Math.abs(item.amount)) || [1]), 1);
  const maxProductVariance = Math.max(...(selectedReport?.topProducts.map((item) => Math.abs(item.varianceAmount)) || [1]), 1);
  const viewMeta = {
    dashboard: ["CMS operativo", "Reportes Bevinco/Sculpture"],
    module1: ["Modulo operativo", "Modulo 1: reportes automatizados Bevinco"],
    reports: ["Bandeja", "Reportes guardados"],
    criteria: ["Base de conocimiento", "Criterios para el agente de reportes"],
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
          <button className={activeView === "criteria" ? "active" : ""} onClick={() => setActiveView("criteria")}><Upload size={18} /> Criterios</button>
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
              <button className="module-card module-card-button" onClick={() => setActiveView("module1")}>
                <div className="module-card-top">
                  <span>01</span>
                  <small>Activo</small>
                </div>
                <h2>Reportes Bevinco</h2>
                <p>Genera el reporte semanal con Variance, Intelipar, resumen ejecutivo, export PDF y email.</p>
                <div className="module-tags">
                  <span>Variance detailed</span>
                  <span>Intelipar</span>
                  <span>Historico 4 periodos</span>
                  <span>PDF y email</span>
                </div>
              </button>
              <button className="module-card module-card-button" onClick={() => setActiveView("criteria")}>
                <div className="module-card-top">
                  <span>02</span>
                  <small>Base</small>
                </div>
                <h2>Criterios del agente</h2>
                <p>Sube documentos internos para que el generador de reportes use reglas, tono, observaciones y aprendizajes del equipo.</p>
                <div className="module-tags">
                  <span>TXT</span>
                  <span>Markdown</span>
                  <span>CSV</span>
                  <span>JSON</span>
                </div>
              </button>
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

        {selectedReport?.analysis ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Analisis del agente</p>
                <h2>Lectura ejecutiva del periodo</h2>
              </div>
              <Bot size={22} />
            </div>
            <div className="agent-analysis-grid">
              <article>
                <strong>Lo mejor de la semana</strong>
                <ul>{(selectedReport.analysis.bestOfWeek || []).map((item) => <li key={item}>{item}</li>)}</ul>
              </article>
              <article>
                <strong>Los desafios de la semana</strong>
                <ul>{(selectedReport.analysis.weeklyChallenges || []).map((item) => <li key={item}>{item}</li>)}</ul>
              </article>
              <article>
                <strong>Eficiencia de stock y compra</strong>
                <ul>{(selectedReport.analysis.stockEfficiency || []).map((item) => <li key={item}>{item}</li>)}</ul>
              </article>
              <article>
                <strong>Criterios aplicados</strong>
                <ul>
                  {(selectedReport.analysis.criteriaApplied?.length
                    ? selectedReport.analysis.criteriaApplied
                    : ["Sin criterios adicionales cargados para este reporte."])
                    .map((item) => <li key={item}>{item}</li>)}
                </ul>
              </article>
            </div>
          </section>
        ) : null}

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
                  <FileSpreadsheet size={17} /> {workStatus === "loading" ? "Cargando datos..." : "Cargar datos al reporte"}
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
                <p className="eyebrow">Reporte generado</p>
                <h2>Resumen ejecutivo para cliente</h2>
              </div>
              <Bot size={22} />
            </div>
            <div className="summary-help">
              <strong>Generador de reporte</strong>
              <small>Usa los CSV cargados para armar el resumen, el email y dejar el reporte guardado en la bandeja de Reportes.</small>
            </div>
            <textarea aria-label="Resumen ejecutivo" value={commentsDraft} onChange={(event) => setCommentsDraft(event.target.value)} />
            <textarea aria-label="Cuerpo del email" value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} />
            <div className="action-row wrap-actions">
              <button className="secondary-button" disabled={!selectedReport || workStatus === "loading"} onClick={generateSummary}>
                <Bot size={17} /> Generar reporte
              </button>
              <button className="primary-button" onClick={() => saveReport({ comments: commentsDraft, emailDraft })}>
                <PencilLine size={17} /> Guardar cambios
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
            <div className="variance-chart">
              {selectedReport?.categoryVariances.map((item) => (
                <article key={item.category}>
                  <div>
                    <strong>{item.category}</strong>
                    <span className={item.amount < 0 ? "negative" : "positive"}>{money(item.amount)} - {item.percent}%</span>
                  </div>
                  <div className="chart-track">
                    <div
                      className={item.amount < 0 ? "negative-bar" : "positive-bar"}
                      style={{ width: `${Math.max(8, (Math.abs(item.amount) / maxCategoryVariance) * 100)}%` }}
                    />
                  </div>
                </article>
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
            <div className="variance-chart">
              {selectedReport?.topProducts.map((item) => (
                <article key={`${item.name}-${item.category}`}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.category}</small>
                    <span className={item.varianceAmount < 0 ? "negative" : "positive"}>{money(item.varianceAmount)} - {item.variancePercent}%</span>
                  </div>
                  <div className="chart-track">
                    <div
                      className={item.varianceAmount < 0 ? "negative-bar" : "positive-bar"}
                      style={{ width: `${Math.max(8, (Math.abs(item.varianceAmount) / maxProductVariance) * 100)}%` }}
                    />
                  </div>
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
              <p className="eyebrow">Guardados</p>
              <h2>Reportes guardados</h2>
            </div>
            <ClipboardList size={22} />
          </div>
          <p className="muted-copy">Cada reporte generado o editado queda guardado por cliente y periodo. Desde esta bandeja puedes abrirlo, revisarlo y exportarlo como PDF.</p>
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
                  <p className="eyebrow">Alimentar al agente</p>
                  <h2>Subir criterios de reporte</h2>
                </div>
                <Upload size={22} />
              </div>
              {error ? <p className="connector-error">{error}</p> : null}
              <div className="upload-box criteria-uploader">
                <label>
                  Archivos de criterio
                  <input
                    accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
                    multiple
                    type="file"
                    onChange={(event) => setSelectedCriteriaFiles(Array.from(event.target.files || []))}
                  />
                </label>
                {selectedCriteriaFiles.length ? (
                  <div className="selected-files">
                    {selectedCriteriaFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
                  </div>
                ) : (
                  <small>Sube guias internas, criterios de analisis, ejemplos de comentarios o reglas comerciales del equipo.</small>
                )}
                <div className="upload-actions">
                  <button
                    className="primary-button"
                    disabled={!selectedCriteriaFiles.length || workStatus === "loading"}
                    onClick={() => importCriteriaFiles()}
                  >
                    <Upload size={17} /> {workStatus === "loading" ? "Cargando criterios..." : "Cargar criterios"}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!selectedCriteriaFiles.length || workStatus === "loading"}
                    onClick={() => setSelectedCriteriaFiles([])}
                  >
                    Limpiar seleccion
                  </button>
                </div>
                <small>Estos documentos quedan guardados en la biblioteca del CMS y el agente los usa al generar el resumen del reporte.</small>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Biblioteca</p>
                  <h2>Criterios disponibles</h2>
                </div>
                <FileText size={22} />
              </div>
              <p className="muted-copy">La biblioteca funciona como memoria operativa: mientras mas criterios reales carguen, mas consistente sera la lectura del reporte semanal.</p>
              <div className="criteria-doc-list">
                {criteriaDocuments.length ? criteriaDocuments.map((document) => (
                  <article key={document.id}>
                    <div>
                      <strong>{document.name}</strong>
                      <small>
                        {new Date(document.uploadedAt).toLocaleDateString("es-CL")} - {Math.max(1, Math.round(document.size / 1024))} KB
                      </small>
                      <p>{document.text.slice(0, 240)}{document.text.length > 240 ? "..." : ""}</p>
                    </div>
                    <button
                      aria-label={`Eliminar ${document.name}`}
                      className="icon-button"
                      disabled={workStatus === "loading"}
                      onClick={() => deleteCriteriaDocument(document.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                )) : (
                  <p className="muted-copy">Aun no hay criterios cargados. Sube el primer archivo para que el agente empiece a usar esa informacion.</p>
                )}
              </div>
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
