import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

/* =======================
   Helpers
======================= */
function n(x, fallback = 0) {
  const v = Number(String(x).replace(",", "."));
  return Number.isFinite(v) ? v : fallback;
}
function int(x, fallback = 0) {
  const v = Math.round(n(x, fallback));
  return Number.isFinite(v) ? v : fallback;
}
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
function formatCOP(value) {
  try {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `$ ${Math.round(value).toLocaleString("es-CO")}`;
  }
}
function formatPct(x) {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(2).replace(".", ",")}%`;
}
function compact(value) {
  try {
    return new Intl.NumberFormat("es-CO", { notation: "compact" }).format(value);
  } catch {
    return String(value);
  }
}

/* =======================
   Incentivos Colombia (modelo simplificado)
======================= */
const INCENTIVOS_CO = [
  { id: "none", nombre: "Ninguno", aplicaIVA: false, aplicaArancel: false, aplicaDeduccionRenta: false },
  { id: "co_full", nombre: "Colombia – Paquete completo (IVA + Arancel + Deducción renta)", aplicaIVA: true, aplicaArancel: true, aplicaDeduccionRenta: true },
  { id: "co_iva", nombre: "Colombia – Exclusión de IVA", aplicaIVA: true, aplicaArancel: false, aplicaDeduccionRenta: false },
  { id: "co_arancel", nombre: "Colombia – Exención de arancel", aplicaIVA: false, aplicaArancel: true, aplicaDeduccionRenta: false },
  { id: "co_renta", nombre: "Colombia – Deducción en renta (hasta 50% inversión, hasta 15 años)", aplicaIVA: false, aplicaArancel: false, aplicaDeduccionRenta: true },
  { id: "co_iva_renta", nombre: "Colombia – IVA + Deducción renta", aplicaIVA: true, aplicaArancel: false, aplicaDeduccionRenta: true },
];

function calcularCapexNeto({ capex, ivaRate, arancelRate, aplicaIVA, aplicaArancel }) {
  let neto = Math.max(0, n(capex, 0));
  if (aplicaIVA) neto = neto / (1 + clamp(n(ivaRate, 0.19), 0, 1));
  if (aplicaArancel) neto = neto / (1 + clamp(n(arancelRate, 0.05), 0, 1));
  return neto;
}

function beneficioDeduccionRentaPorAno({
  capexNeto,
  vida,
  aplica,
  anosAplicacion,
  ingresoGravableAnual,
  tasaImpuestoRenta,
}) {
  const vidaN = clamp(int(vida, 25), 1, 30);
  if (!aplica) return Array(vidaN).fill(0);

  const anos = clamp(int(anosAplicacion, 5), 1, 15);
  const capex = Math.max(0, n(capexNeto, 0));
  const ingreso = Math.max(0, n(ingresoGravableAnual, 0));
  const tasa = clamp(n(tasaImpuestoRenta, 0.35), 0, 1);

  const totalDeducible = 0.5 * capex;
  const cuota = totalDeducible / anos;

  let restante = totalDeducible;
  const out = Array(vidaN).fill(0);

  for (let y = 1; y <= vidaN; y++) {
    if (y > anos || restante <= 0) break;
    const topeAnual = 0.5 * ingreso;
    const ded = Math.min(cuota, restante, topeAnual);
    out[y - 1] = ded * tasa;
    restante -= ded;
  }
  return out;
}

/* =======================
   Finance
======================= */
function npv(rate, cashflows) {
  return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}
function irr(cashflows) {
  let low = -0.95;
  let high = 3.0;
  const f = (r) => npv(r, cashflows);
  const fLow = f(low);
  const fHigh = f(high);
  if (!Number.isFinite(fLow) || !Number.isFinite(fHigh)) return null;
  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 90; i++) {
    const mid = (low + high) / 2;
    const fMid = f(mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLow * fMid <= 0) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}
function paybackYear(cashflows) {
  let cum = 0;
  for (let t = 0; t < cashflows.length; t++) {
    cum += cashflows[t];
    if (cum >= 0) return t;
  }
  return null;
}

/* =======================
   Tarifa variable
======================= */
function parseTariffList(text) {
  const raw = String(text || "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = raw.map((s) => n(s)).filter((v) => Number.isFinite(v));
  return nums;
}

function tariffForYear({ mode, baseTariff, escTarifa, manualList, volatility, cycleYears, year }) {
  if (year <= 0) return baseTariff;

  if (mode === "manual") {
    if (manualList.length >= year) return manualList[year - 1];
    const last = manualList.length ? manualList[manualList.length - 1] : baseTariff;
    const extraYears = year - manualList.length;
    return last * Math.pow(1 + escTarifa, extraYears);
  }

  if (mode === "ciclico") {
    const cyc = clamp(cycleYears, 2, 10);
    const vol = clamp(volatility, 0, 0.5);
    const base = baseTariff * Math.pow(1 + escTarifa, year - 1);
    const mult = 1 + vol * Math.sin((2 * Math.PI * (year - 1)) / cyc);
    return base * mult;
  }

  return baseTariff * Math.pow(1 + escTarifa, year - 1);
}

/* =======================
   Model per scenario
======================= */
function computeScenarioModel(s) {
  const vida = clamp(int(s.vida, 25), 1, 30);
  const potencia = Math.max(0, n(s.potencia, 0));
  const psh = clamp(n(s.psh, 4.5), 0, 8);
  const pr = clamp(n(s.pr, 0.8), 0, 1);
  const degrad = clamp(n(s.degrad, 0.006), 0, 0.05);
  const autoconsumo = clamp(n(s.autoconsumo, 1), 0, 1);

  const capexBruto = Math.max(0, n(s.capex, 0));
  const om = Math.max(0, n(s.om, 0));
  const tasaDesc = clamp(n(s.tasaDesc, 0.12), 0.000001, 0.8);

  const tarifaBase = Math.max(0, n(s.tarifaBase, 0));
  const escTarifa = clamp(n(s.escTarifa, 0.04), -0.2, 0.8);

  const tariffMode = s.tariffMode || "escalado";
  const list = parseTariffList(s.tarifaLista || "").map((v) => Math.max(0, v));
  const vol = clamp(n(s.volatilidad, 0.1), 0, 0.5);
  const cyc = clamp(int(s.ciclo, 4), 2, 10);

  const inc = INCENTIVOS_CO.find((x) => x.id === s.incentivoId) || INCENTIVOS_CO[0];
  const ivaRate = clamp(n(s.ivaRate, 0.19), 0, 1);
  const arancelRate = clamp(n(s.arancelRate, 0.05), 0, 1);

  const capexNeto = calcularCapexNeto({
    capex: capexBruto,
    ivaRate,
    arancelRate,
    aplicaIVA: inc.aplicaIVA,
    aplicaArancel: inc.aplicaArancel,
  });

  const beneficiosRenta = beneficioDeduccionRentaPorAno({
    capexNeto,
    vida,
    aplica: inc.aplicaDeduccionRenta,
    anosAplicacion: s.anosDeduccionRenta,
    ingresoGravableAnual: s.ingresoGravableAnual,
    tasaImpuestoRenta: s.tasaImpuestoRenta,
  });

  const rows = [];
  let cum = 0;

  for (let y = 0; y <= vida; y++) {
    if (y === 0) {
      const neto0 = -capexNeto;
      cum += neto0;
      rows.push({ year: 0, tarifa: 0, energia: 0, ahorro: 0, om: 0, incentivoRenta: 0, neto: neto0, acumulado: cum });
      continue;
    }

    const energia = potencia * psh * 365 * pr * Math.pow(1 - degrad, y - 1);
    const tarifaY = tariffForYear({
      mode: tariffMode,
      baseTariff: tarifaBase,
      escTarifa,
      manualList: list,
      volatility: vol,
      cycleYears: cyc,
      year: y,
    });

    const ahorro = energia * tarifaY * autoconsumo;
    const omY = om * Math.pow(1 + Math.max(0, escTarifa), y - 1);
    const incentivoRenta = beneficiosRenta[y - 1] || 0;

    const neto = ahorro - omY + incentivoRenta;
    cum += neto;

    rows.push({ year: y, tarifa: tarifaY, energia, ahorro, om: omY, incentivoRenta, neto, acumulado: cum });
  }

  const cashflows = rows.map((r) => r.neto);
  const vpn = npv(tasaDesc, cashflows);
  const tir = irr(cashflows);
  const payback = paybackYear(cashflows);
  const roi1 = capexNeto > 0 && rows[1] ? rows[1].neto / capexNeto : null;

  const conclusions = [];
  if (inc.id === "none") conclusions.push("Incentivos tributarios: ninguno (simulación).");
  else {
    const parts = [];
    if (inc.aplicaIVA) parts.push("exclusión de IVA (CAPEX neto menor)");
    if (inc.aplicaArancel) parts.push("exención de arancel (CAPEX neto menor)");
    if (inc.aplicaDeduccionRenta) parts.push("deducción en renta (beneficio anual simulado)");
    conclusions.push(`Incentivos tributarios: ${parts.join(" + ")}.`);
    conclusions.push("Nota: simulación simplificada; la elegibilidad real depende de requisitos y soportes.");
  }

  if (tariffMode === "manual") conclusions.push("Precio de energía: variable por lista manual (año a año).");
  if (tariffMode === "ciclico") conclusions.push("Precio de energía: variable (cíclico/mercado).");
  if (tariffMode === "escalado") conclusions.push("Precio de energía: escalamiento fijo anual.");

  conclusions.push(vpn > 0 ? "Rentabilidad: VPN positivo (viable)." : "Rentabilidad: VPN negativo (ajusta supuestos).");

  if (tir !== null) conclusions.push(tir > tasaDesc ? "La TIR supera la tasa de descuento: atractivo." : "La TIR no supera la tasa de descuento: revisar.");
  else conclusions.push("TIR no calculable (no converge o flujo no cambia de signo).");

  conclusions.push(payback !== null ? `Payback estimado: año ${payback}.` : "No se recupera dentro del horizonte.");

  return { vida, rows, vpn, tir, payback, roi1, conclusions, capexNeto };
}

/* =======================
   Defaults
======================= */
const DEFAULTS = {
  A: {
    name: "Conservador",
    vida: 25,
    tarifaBase: 850,
    potencia: 6,
    psh: 4.2,
    pr: 0.78,
    degrad: 0.007,
    autoconsumo: 0.8,
    capex: 22000000,
    om: 420000,
    escTarifa: 0.03,
    tasaDesc: 0.13,
    tariffMode: "escalado",
    tarifaLista: "850, 880, 910, 940",
    volatilidad: 0.1,
    ciclo: 4,
    incentivoId: "none",
    ivaRate: 0.19,
    arancelRate: 0.05,
    ingresoGravableAnual: 60000000,
    tasaImpuestoRenta: 0.35,
    anosDeduccionRenta: 5,
  },
  B: {
    name: "Base",
    vida: 25,
    tarifaBase: 900,
    potencia: 8,
    psh: 4.5,
    pr: 0.8,
    degrad: 0.006,
    autoconsumo: 0.85,
    capex: 26000000,
    om: 450000,
    escTarifa: 0.04,
    tasaDesc: 0.12,
    tariffMode: "escalado",
    tarifaLista: "900, 930, 960, 1000",
    volatilidad: 0.12,
    ciclo: 4,
    incentivoId: "co_full",
    ivaRate: 0.19,
    arancelRate: 0.05,
    ingresoGravableAnual: 90000000,
    tasaImpuestoRenta: 0.35,
    anosDeduccionRenta: 5,
  },
  C: {
    name: "Optimista",
    vida: 25,
    tarifaBase: 950,
    potencia: 10,
    psh: 4.8,
    pr: 0.82,
    degrad: 0.005,
    autoconsumo: 0.9,
    capex: 28000000,
    om: 480000,
    escTarifa: 0.05,
    tasaDesc: 0.11,
    tariffMode: "ciclico",
    tarifaLista: "950, 980, 1020, 1050",
    volatilidad: 0.18,
    ciclo: 4,
    incentivoId: "co_iva_renta",
    ivaRate: 0.19,
    arancelRate: 0.05,
    ingresoGravableAnual: 120000000,
    tasaImpuestoRenta: 0.35,
    anosDeduccionRenta: 7,
  },
};

export default function SmartEnergyROIApp() {
  const [modeIng, setModeIng] = useState(true);
  const [active, setActive] = useState("B");
  const [scenarios, setScenarios] = useState(() => ({
    A: { ...DEFAULTS.A },
    B: { ...DEFAULTS.B },
    C: { ...DEFAULTS.C },
  }));

  const models = useMemo(() => {
    const mA = computeScenarioModel(scenarios.A);
    const mB = computeScenarioModel(scenarios.B);
    const mC = computeScenarioModel(scenarios.C);

    const chart = Array.from({ length: Math.max(mA.vida, mB.vida, mC.vida) + 1 }, (_, y) => {
      const rowA = mA.rows[y] || mA.rows[mA.rows.length - 1];
      const rowB = mB.rows[y] || mB.rows[mB.rows.length - 1];
      const rowC = mC.rows[y] || mC.rows[mC.rows.length - 1];
      return { year: y, A: Math.round(rowA.acumulado), B: Math.round(rowB.acumulado), C: Math.round(rowC.acumulado) };
    });

    return { A: mA, B: mB, C: mC, chart };
  }, [scenarios]);

  const activeScenario = scenarios[active];
  const activeModel = models[active];

  function updateActive(field, value) {
    setScenarios((prev) => ({ ...prev, [active]: { ...prev[active], [field]: value } }));
  }
  function duplicateTo(targetKey) {
    setScenarios((prev) => ({ ...prev, [targetKey]: { ...prev[active] } }));
  }
  function resetAll() {
    setScenarios({ A: { ...DEFAULTS.A }, B: { ...DEFAULTS.B }, C: { ...DEFAULTS.C } });
    setActive("B");
  }
  function exportPDF() {
    window.print();
  }

  const incActive = INCENTIVOS_CO.find((x) => x.id === activeScenario.incentivoId) || INCENTIVOS_CO[0];

  return (
    <div style={{ minHeight: "100vh", padding: 18, background: "#0b1220", color: "rgba(255,255,255,0.92)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>
            <span style={{ color: "#22c55e" }}>Smart</span>{" "}
            <span style={{ color: "#3b82f6" }}>Energy</span> ROI{" "}
            <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.15)", marginLeft: 10 }}>
              v2.0
            </span>
          </h1>
          <div style={{ opacity: 0.8, marginTop: 4 }}>
            Escenarios A/B/C • Incentivos Colombia • Precio energía variable • Reporte PDF
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setModeIng((v) => !v)} style={btn()}>
            {modeIng ? "Modo Ingeniero" : "Modo Cliente"}
          </button>
          <button onClick={exportPDF} style={btn(true)}>Exportar PDF</button>
          <button onClick={resetAll} style={btn()}>Reiniciar</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16, marginTop: 16 }}>
        {/* Left column */}
        <div style={{ display: "grid", gap: 16 }}>
          {/* Scenarios */}
          <Card title="Escenarios">
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {(["A", "B", "C"]).map((k) => (
                <button
                  key={k}
                  onClick={() => setActive(k)}
                  style={btn(false, active === k)}
                >
                  {k} • {scenarios[k].name}
                </button>
              ))}
            </div>

            <hr style={hr()} />

            <div style={{ opacity: 0.8, fontSize: 13 }}>
              Consejo: usa “Duplicar” para copiar supuestos del escenario activo a otro.
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <button style={btn()} onClick={() => duplicateTo("A")}>Duplicar a A</button>
              <button style={btn()} onClick={() => duplicateTo("B")}>Duplicar a B</button>
              <button style={btn()} onClick={() => duplicateTo("C")}>Duplicar a C</button>
            </div>
          </Card>

          {/* Inputs */}
          <Card title={`Entradas • Escenario ${active}`}>
            <div style={{ opacity: 0.8, fontSize: 13 }}>
              {modeIng ? "Modo Ingeniero: inputs completos" : "Modo Cliente: inputs esenciales"}
            </div>

            <hr style={hr()} />

            <Grid2>
              <Field label="Nombre del escenario">
                <input value={activeScenario.name} onChange={(e) => updateActive("name", e.target.value)} style={input()} />
              </Field>
              <Field label="Vida útil (años)">
                <input value={activeScenario.vida} onChange={(e) => updateActive("vida", e.target.value)} style={input()} />
              </Field>
            </Grid2>

            <Grid2>
              <Field label="Tarifa base (COP/kWh)">
                <input value={activeScenario.tarifaBase} onChange={(e) => updateActive("tarifaBase", e.target.value)} style={input()} />
              </Field>
              <Field label="Potencia FV (kW)">
                <input value={activeScenario.potencia} onChange={(e) => updateActive("potencia", e.target.value)} style={input()} />
              </Field>
            </Grid2>

            <Grid2>
              <Field label="% autoconsumo (0–1)">
                <input value={activeScenario.autoconsumo} onChange={(e) => updateActive("autoconsumo", e.target.value)} style={input()} />
              </Field>
              <Field label="CAPEX (COP)">
                <input value={activeScenario.capex} onChange={(e) => updateActive("capex", e.target.value)} style={input()} />
              </Field>
            </Grid2>

            <Field label="O&M anual (COP)">
              <input value={activeScenario.om} onChange={(e) => updateActive("om", e.target.value)} style={input()} />
            </Field>

            <hr style={hr()} />

            <div style={{ fontWeight: 900, marginBottom: 8 }}>Incentivos tributarios (Colombia)</div>

            <Field label="Selecciona un esquema">
              <select value={activeScenario.incentivoId} onChange={(e) => updateActive("incentivoId", e.target.value)} style={input()}>
                {INCENTIVOS_CO.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.nombre}</option>
                ))}
              </select>
            </Field>

            {modeIng ? (
              <>
                <Grid2>
                  <Field label="IVA asumido (0–1)">
                    <input value={activeScenario.ivaRate} onChange={(e) => updateActive("ivaRate", e.target.value)} style={input()} />
                  </Field>
                  <Field label="Arancel asumido (0–1)">
                    <input value={activeScenario.arancelRate} onChange={(e) => updateActive("arancelRate", e.target.value)} style={input()} />
                  </Field>
                </Grid2>

                {incActive.aplicaDeduccionRenta ? (
                  <div style={{ marginTop: 10, padding: 12, borderRadius: 12, border: "1px solid rgba(255,255,255,0.12)" }}>
                    <div style={{ fontWeight: 900, marginBottom: 8 }}>Deducción en renta (simulación)</div>

                    <Grid2>
                      <Field label="Ingreso gravable anual (COP/año)">
                        <input value={activeScenario.ingresoGravableAnual} onChange={(e) => updateActive("ingresoGravableAnual", e.target.value)} style={input()} />
                      </Field>
                      <Field label="Tasa impuesto renta (0–1)">
                        <input value={activeScenario.tasaImpuestoRenta} onChange={(e) => updateActive("tasaImpuestoRenta", e.target.value)} style={input()} />
                      </Field>
                    </Grid2>

                    <Field label="Años para aplicar deducción (1–15)">
                      <input value={activeScenario.anosDeduccionRenta} onChange={(e) => updateActive("anosDeduccionRenta", e.target.value)} style={input()} />
                    </Field>

                    <div style={{ opacity: 0.75, fontSize: 12, marginTop: 8 }}>
                      Modelo simplificado: hasta 50% de inversión, hasta 15 años, con tope anual aproximado.
                    </div>
                  </div>
                ) : null}

                <hr style={hr()} />

                <Grid2>
                  <Field label="PSH (h/día)">
                    <input value={activeScenario.psh} onChange={(e) => updateActive("psh", e.target.value)} style={input()} />
                  </Field>
                  <Field label="PR (0–1)">
                    <input value={activeScenario.pr} onChange={(e) => updateActive("pr", e.target.value)} style={input()} />
                  </Field>
                </Grid2>

                <Grid2>
                  <Field label="Degradación anual">
                    <input value={activeScenario.degrad} onChange={(e) => updateActive("degrad", e.target.value)} style={input()} />
                  </Field>
                  <Field label="Tasa de descuento (anual)">
                    <input value={activeScenario.tasaDesc} onChange={(e) => updateActive("tasaDesc", e.target.value)} style={input()} />
                  </Field>
                </Grid2>

                <Grid2>
                  <Field label="Escalamiento tarifa (anual)">
                    <input value={activeScenario.escTarifa} onChange={(e) => updateActive("escTarifa", e.target.value)} style={input()} />
                  </Field>
                  <Field label="Modo de tarifa">
                    <select value={activeScenario.tariffMode} onChange={(e) => updateActive("tariffMode", e.target.value)} style={input()}>
                      <option value="escalado">Escalamiento fijo</option>
                      <option value="manual">Manual (lista por año)</option>
                      <option value="ciclico">Variable (cíclica/mercado)</option>
                    </select>
                  </Field>
                </Grid2>

                {activeScenario.tariffMode === "manual" ? (
                  <Field label="Tarifas por año (coma o salto de línea)">
                    <textarea value={activeScenario.tarifaLista} onChange={(e) => updateActive("tarifaLista", e.target.value)} style={textarea()} />
                  </Field>
                ) : null}

                {activeScenario.tariffMode === "ciclico" ? (
                  <Grid2>
                    <Field label="Volatilidad (0–0.5)">
                      <input value={activeScenario.volatilidad} onChange={(e) => updateActive("volatilidad", e.target.value)} style={input()} />
                    </Field>
                    <Field label="Ciclo (años)">
                      <input value={activeScenario.ciclo} onChange={(e) => updateActive("ciclo", e.target.value)} style={input()} />
                    </Field>
                  </Grid2>
                ) : null}
              </>
            ) : (
              <div style={{ opacity: 0.8, fontSize: 12, marginTop: 10 }}>
                Activa “Modo Ingeniero” para ajustar parámetros avanzados.
              </div>
            )}
          </Card>
        </div>

        {/* Right column */}
        <div style={{ display: "grid", gap: 16 }}>
          <Card title="Gráfica comparativa">
            <div style={{ opacity: 0.8, fontSize: 13 }}>Flujo acumulado por escenario (A/B/C).</div>

            <div style={{ height: 320, marginTop: 10 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={models.chart} margin={{ top: 10, right: 16, left: 6, bottom: 10 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.10)" />
                  <XAxis dataKey="year" tick={{ fill: "rgba(255,255,255,0.75)" }} />
                  <YAxis tick={{ fill: "rgba(255,255,255,0.75)" }} tickFormatter={(v) => compact(v)} width={72} />
                  <Tooltip
                    formatter={(value) => formatCOP(value)}
                    labelFormatter={(l) => `Año ${l}`}
                    contentStyle={{
                      background: "rgba(10,16,28,0.92)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 12,
                      color: "rgba(255,255,255,0.92)",
                    }}
                  />
                  <Legend wrapperStyle={{ color: "rgba(255,255,255,0.80)" }} />
                  <Line type="monotone" dataKey="A" name="Acumulado A" stroke="rgba(34,197,94,0.95)" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="B" name="Acumulado B" stroke="rgba(59,130,246,0.95)" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="C" name="Acumulado C" stroke="rgba(168,85,247,0.95)" strokeWidth={3} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ opacity: 0.75, fontSize: 12, marginTop: 10 }}>
              Nota: la deducción en renta se modela como flujo anual adicional (simulación).
            </div>
          </Card>

          <Card title={`Conclusiones • Escenario ${active} (${activeScenario.name})`}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
              <KPI label="VPN" value={formatCOP(activeModel.vpn)} color="#22c55e" />
              <KPI label="TIR" value={activeModel.tir === null ? "—" : formatPct(activeModel.tir)} color="#3b82f6" />
            </div>

            <hr style={hr()} />

            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.65, color: "rgba(255,255,255,0.86)" }}>
              {activeModel.conclusions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>

            <div style={{ opacity: 0.75, fontSize: 12, marginTop: 10 }}>
              CAPEX neto (con incentivos): <b>{formatCOP(activeModel.capexNeto)}</b>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* =======================
   Mini UI helpers
======================= */
function Card({ title, children }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: 18,
      padding: 14,
      boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
    }}>
      <div style={{ fontWeight: 900, fontSize: 16 }}>{title}</div>
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}
function KPI({ label, value, color }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: 16,
      padding: 12,
    }}>
      <div style={{ opacity: 0.8, fontSize: 12 }}>{label}</div>
      <div style={{ fontWeight: 900, fontSize: 20, color }}>{value}</div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginTop: 10 }}>
      <div style={{ opacity: 0.85, fontSize: 12, marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  );
}
function Grid2({ children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {children}
    </div>
  );
}
function btn(primary = false, active = false) {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: active ? "1px solid rgba(59,130,246,0.65)" : "1px solid rgba(255,255,255,0.14)",
    background: primary
      ? "linear-gradient(90deg, rgba(34,197,94,0.9), rgba(59,130,246,0.9))"
      : active
        ? "rgba(59,130,246,0.18)"
        : "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.92)",
    fontWeight: 800,
    cursor: "pointer",
  };
}
function input() {
  return {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,16,28,0.55)",
    color: "rgba(255,255,255,0.92)",
    padding: "10px 10px",
    outline: "none",
  };
}
function textarea() {
  return {
    width: "100%",
    minHeight: 90,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,16,28,0.55)",
    color: "rgba(255,255,255,0.92)",
    padding: "10px 10px",
    outline: "none",
    resize: "vertical",
  };
}
function hr() {
  return { border: "none", borderTop: "1px solid rgba(255,255,255,0.10)", margin: "14px 0" };
}
