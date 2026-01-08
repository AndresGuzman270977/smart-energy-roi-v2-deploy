import React, { useMemo, useRef, useState } from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend
} from "recharts";

/* ---------------- Helpers ---------------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtCOP = (n) =>
  new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(
    Math.round(n || 0)
  );

const fmtPct = (n) =>
  `${(100 * (n || 0)).toLocaleString("es-CO", { maximumFractionDigits: 2 })}%`;

function npv(rate, cashflows) {
  return cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}

function irr(cashflows) {
  const hasNeg = cashflows.some((x) => x < 0);
  const hasPos = cashflows.some((x) => x > 0);
  if (!hasNeg || !hasPos) return null;

  let low = -0.99;
  let high = 5.0;
  for (let i = 0; i < 140; i++) {
    const mid = (low + high) / 2;
    const v = npv(mid, cashflows);
    if (Math.abs(v) < 1e-4) return mid;
    if (v > 0) low = mid;
    else high = mid;
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

function yearlyGenerationKwh({ kW, psh, pr, deg, year }) {
  const base = kW * psh * 365 * pr;
  const factor = Math.pow(1 - deg, year - 1);
  return base * factor;
}

/**
 * Volatilidad estable (no cambia con re-renders)
 */
function stableNoise01(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000; // [0,1)
}

/* ---------------- Incentivos (simulación) ---------------- */
const INCENTIVOS = [
  { key: "none", name: "Ninguno" },
  { key: "co_iva", name: "Colombia – Solo exclusión de IVA (simulación)" },
  { key: "co_iva_arancel", name: "Colombia – IVA + Arancel (simulación)" },
  { key: "co_full", name: "Colombia – Paquete completo (IVA + Arancel + Deducción renta)" }
];

function applyIncentives(capexBruto, opt) {
  const ivaRate = clamp(opt.ivaRate, 0, 0.3);
  const arancelRate = clamp(opt.arancelRate, 0, 0.2);

  let capexNeto = capexBruto;

  // IVA (si capexBruto incluye IVA)
  if (opt.scheme === "co_iva" || opt.scheme === "co_iva_arancel" || opt.scheme === "co_full") {
    capexNeto = capexNeto / (1 + ivaRate);
  }

  // Arancel (simulación como reducción)
  if (opt.scheme === "co_iva_arancel" || opt.scheme === "co_full") {
    capexNeto = capexNeto * (1 - arancelRate);
  }

  // Deducción renta (flujo anual adicional simulado)
  let taxBenefitAnnual = 0;
  if (opt.scheme === "co_full") {
    const deductionBase = 0.5 * capexNeto;
    const deductionYears = Math.max(1, Math.round(opt.deductionYears));
    const taxRate = clamp(opt.taxRate, 0, 0.5);
    taxBenefitAnnual = (deductionBase / deductionYears) * taxRate;
  }

  return { capexNeto, taxBenefitAnnual };
}

/* ---------------- Scenario Model ---------------- */
function computeScenario(s, global, seedTag = "base") {
  const years = Math.max(5, Math.round(s.lifeYears));
  const discount = clamp(s.discountRate, 0.01, 0.6);

  const { capexNeto, taxBenefitAnnual } = applyIncentives(s.capex, {
    scheme: s.incentiveScheme,
    ivaRate: s.ivaRate,
    arancelRate: s.arancelRate,
    taxRate: s.taxRate,
    deductionYears: s.deductionYears
  });

  const cashflows = new Array(years + 1).fill(0);
  cashflows[0] = -capexNeto;

  const tariff0 = Math.max(0, s.tariff);
  const esc = clamp(s.tariffEscalation, 0, 0.35);
  const vol = clamp(s.tariffVolatility, 0, 0.5);

  // Con/Sin excedentes
  const exportFactor = global.includeExports ? clamp(s.exportFactor, 0, 1) : 0;

  const selfFrac = clamp(s.selfConsumption, 0, 1);
  let om = Math.max(0, s.omAnnual);

  const annuals = [];

  for (let y = 1; y <= years; y++) {
    const baseTariff = tariff0 * Math.pow(1 + esc, y - 1);

    let tariffY = baseTariff;
    if (global.useVolatility) {
      const u = stableNoise01(`${seedTag}|${y}|${tariff0}|${esc}|${vol}`);
      const jitter = 1 + (u * 2 - 1) * vol;
      tariffY = Math.max(0, baseTariff * jitter);
    }

    const gen = yearlyGenerationKwh({
      kW: s.kW,
      psh: s.psh,
      pr: s.pr,
      deg: s.degAnnual,
      year: y
    });

    const selfKwh = gen * selfFrac;
    const expKwh = gen * (1 - selfFrac);

    const exportPrice = tariffY * exportFactor;

    const savingsSelf = selfKwh * tariffY;
    const revenueExp = expKwh * exportPrice;
    const savings = savingsSelf + revenueExp;

    if (y > 1) om = om * (1 + esc);

    const benefitTax = global.includeTaxBenefit ? taxBenefitAnnual : 0;
    const net = savings - om + benefitTax;

    cashflows[y] = net;

    annuals.push({
      year: y,
      tariff: tariffY,
      generationKwh: gen,
      selfKwh,
      expKwh,
      savingsSelf,
      revenueExp,
      savings,
      om,
      taxBenefit: benefitTax,
      net,
      cum: (annuals[y - 2]?.cum || cashflows[0]) + net
    });
  }

  const NPV = npv(discount, cashflows);
  const IRR = irr(cashflows);
  const pb = paybackYear(cashflows);
  const roi1 = cashflows[1] / capexNeto;

  const y1 = annuals[0];
  const exportShareY1 =
    y1 && y1.savings > 0 ? clamp(y1.revenueExp / y1.savings, 0, 1) : 0;

  return {
    years,
    capexNeto,
    cashflows,
    annuals,
    NPV,
    IRR,
    payback: pb,
    roi1,
    exportShareY1
  };
}

/* ---------------- UI ---------------- */
const defaultScenario = (name, colorKey) => ({
  name,
  colorKey,
  kW: 22.2,
  lifeYears: 25,
  tariff: 1080,
  tariffEscalation: 0.08,
  tariffVolatility: 0.08,
  selfConsumption: 0.65,
  capex: 64727982,
  omAnnual: 450000,
  discountRate: 0.12,
  // Engineer
  psh: 4.1,
  pr: 0.8,
  degAnnual: 0.006,
  exportFactor: 0.45,
  // Incentivos
  incentiveScheme: "co_full",
  ivaRate: 0.19,
  arancelRate: 0.05,
  taxRate: 0.35,
  deductionYears: 15
});

function EnergyIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z"
        stroke="url(#g)"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient id="g" x1="4" y1="22" x2="20" y2="2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22c55e" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function App() {
  const [active, setActive] = useState("B");
  const [engineer, setEngineer] = useState(true);

  const [global, setGlobal] = useState({
    includeTaxBenefit: true,
    useVolatility: false,
    includeExports: true
  });

  const [sc, setSc] = useState({
    A: defaultScenario("Conservador", "green"),
    B: { ...defaultScenario("Base", "blue"), tariff: 1080, selfConsumption: 0.65 },
    C: { ...defaultScenario("Optimista", "purple"), tariff: 1200, selfConsumption: 0.75, tariffEscalation: 0.1 }
  });

  const models = useMemo(() => {
    return {
      A: computeScenario(sc.A, global, "A"),
      B: computeScenario(sc.B, global, "B"),
      C: computeScenario(sc.C, global, "C")
    };
  }, [sc, global.includeTaxBenefit, global.useVolatility, global.includeExports]);

  const activeScenario = sc[active];
  const activeModel = models[active];

  const modelWithExports = useMemo(() => {
    return computeScenario(activeScenario, { ...global, includeExports: true }, `${active}|with`);
  }, [activeScenario, global.includeTaxBenefit, global.useVolatility, active]);

  const modelNoExports = useMemo(() => {
    return computeScenario(activeScenario, { ...global, includeExports: false }, `${active}|no`);
  }, [activeScenario, global.includeTaxBenefit, global.useVolatility, active]);

  const chartData = useMemo(() => {
    const years = activeModel.years;
    const data = [];
    for (let y = 0; y <= years; y++) {
      const aCum = y === 0 ? models.A.cashflows[0] : models.A.cashflows.slice(0, y + 1).reduce((p, c) => p + c, 0);
      const bCum = y === 0 ? models.B.cashflows[0] : models.B.cashflows.slice(0, y + 1).reduce((p, c) => p + c, 0);
      const cCum = y === 0 ? models.C.cashflows[0] : models.C.cashflows.slice(0, y + 1).reduce((p, c) => p + c, 0);
      data.push({ year: y, A: aCum, B: bCum, C: cCum });
    }
    return data;
  }, [models, activeModel.years]);

  const update = (key, value) => {
    setSc((prev) => ({
      ...prev,
      [active]: {
        ...prev[active],
        [key]: value
      }
    }));
  };

  const duplicateTo = (targetKey) => {
    setSc((prev) => ({
      ...prev,
      [targetKey]: { ...prev[active], name: prev[targetKey].name, colorKey: prev[targetKey].colorKey }
    }));
  };

  const reset = () => {
    setSc({
      A: defaultScenario("Conservador", "green"),
      B: { ...defaultScenario("Base", "blue"), tariff: 1080, selfConsumption: 0.65 },
      C: { ...defaultScenario("Optimista", "purple"), tariff: 1200, selfConsumption: 0.75, tariffEscalation: 0.1 }
    });
  };

  const reportRef = useRef(null);

  async function exportPDF() {
    const el = reportRef.current;
    if (!el) return;
    await new Promise((r) => setTimeout(r, 50));

    const canvas = await html2canvas(el, {
      scale: 2.2,
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
      windowWidth: 920
    });

    const imgData = canvas.toDataURL("image/png", 1.0);
    const pdf = new jsPDF("p", "mm", "a4");
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    const imgW = pageW;
    const imgH = (canvas.height * imgW) / canvas.width;

    if (imgH <= pageH) {
      pdf.addImage(imgData, "PNG", 0, 0, imgW, imgH);
    } else {
      let remaining = imgH;
      let position = 0;
      while (remaining > 0) {
        pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
        remaining -= pageH;
        position -= pageH;
        if (remaining > 0) pdf.addPage();
      }
    }

    pdf.save(`Smart_Energy_ROI_${activeScenario.name}_v2_PRO.pdf`);
  }

  const conclusions = useMemo(() => {
    const { NPV, IRR, payback, exportShareY1 } = activeModel;
    const scheme = activeScenario.incentiveScheme;
    const schemeName = INCENTIVOS.find((x) => x.key === scheme)?.name || "Ninguno";

    const lines = [];

    lines.push(
      global.includeExports
        ? "Excedentes: incluidos (venta/compensación)."
        : "Excedentes: no incluidos (solo autoconsumo)."
    );

    if (global.includeExports) {
      lines.push(`Señal PRO: año 1 ~${fmtPct(exportShareY1)} de ingresos proviene de excedentes.`);
      if (exportShareY1 >= 0.35) {
        lines.push("⚠️ Alto peso de excedentes: revisar sobredimensionamiento / negociar CAPEX.");
      }
    }

    if (scheme !== "none") {
      if (scheme === "co_full") lines.push("Incentivos CO: IVA + arancel + deducción renta (simulación).");
      else if (scheme === "co_iva_arancel") lines.push("Incentivos CO: IVA + arancel (simulación).");
      else if (scheme === "co_iva") lines.push("Incentivos CO: exclusión IVA (simulación).");
      lines.push("Nota: elegibilidad real depende de requisitos y soportes del contribuyente.");
    } else {
      lines.push("Sin incentivos tributarios considerados.");
    }

    if (NPV > 0) lines.push("Rentabilidad: VPN positivo (viable).");
    else lines.push("Rentabilidad: VPN negativo (revisar supuestos).");

    if (IRR != null && IRR > activeScenario.discountRate) lines.push("La TIR supera la tasa de descuento: atractivo.");
    else lines.push("La TIR no supera la tasa de descuento: revisar supuestos.");

    if (payback != null) lines.push(`Payback estimado: año ${payback}.`);
    else lines.push("Payback: no recupera inversión dentro del horizonte.");

    if (global.useVolatility) lines.push("Tarifa: variable con volatilidad estable (sensibilidad).");
    else lines.push("Tarifa: escalamiento fijo anual.");

    const deltaNPV = modelWithExports.NPV - modelNoExports.NPV;
    lines.push(`Impacto excedentes en VPN (Con − Sin): $ ${fmtCOP(deltaNPV)}.`);
    lines.push(`Esquema incentivos: ${schemeName}.`);

    return lines;
  }, [activeModel, activeScenario, global.includeExports, global.useVolatility, modelWithExports.NPV, modelNoExports.NPV]);

  return (
    <div className="container">
      <div className="topbar">
        <div>
          <div className="brand">
            <div className="logo"><EnergyIcon /></div>
            <div>
              <div className="title">
                <span className="g">Smart</span> <span className="b">Energy</span> ROI{" "}
                <span style={{ fontSize: 12, opacity: 0.9 }}>v2.0 PRO</span>
              </div>
              <div className="subtitle">
                A/B/C • Incentivos Colombia • Tarifa variable • Con/Sin excedentes • PDF PRO
              </div>
            </div>
          </div>
        </div>

        <div className="actions">
          <button className="btn" onClick={() => setEngineer((v) => !v)}>
            {engineer ? "Modo Cliente" : "Modo Ingeniero"}
          </button>
          <button className="btn primary" onClick={exportPDF}>Exportar PDF</button>
          <button className="btn" onClick={reset}>Reiniciar</button>
        </div>
      </div>

      <div className="grid">
        <div style={{ display: "grid", gap: 14 }}>
          <div className="card">
            <h3>Escenarios</h3>
            <div className="small">Trabaja con A/B/C. Cambia el activo y compara resultados.</div>

            <div className="segment">
              {["A", "B", "C"].map((k) => (
                <button key={k} className={`pill ${active === k ? "active" : ""}`} onClick={() => setActive(k)}>
                  {k} • {sc[k].name}
                </button>
              ))}
            </div>

            <div className="hr" />
            <div className="small">Consejo: usa “Duplicar” para copiar supuestos del escenario activo a otro.</div>
            <div className="segment">
              <button className="btn" onClick={() => duplicateTo("A")}>Duplicar a A</button>
              <button className="btn" onClick={() => duplicateTo("B")}>Duplicar a B</button>
              <button className="btn" onClick={() => duplicateTo("C")}>Duplicar a C</button>
            </div>
          </div>

          <div className="card">
            <h3>Entradas • Escenario {active} ({activeScenario.name})</h3>
            <div className="small">{engineer ? "Modo Ingeniero: inputs completos" : "Modo Cliente: inputs esenciales"}</div>

            <div className="form">
              <div className="field">
                <label>Nombre del escenario</label>
                <input value={activeScenario.name} onChange={(e) => update("name", e.target.value)} />
              </div>

              <div className="field">
                <label>Vida útil (años)</label>
                <input type="number" value={activeScenario.lifeYears} onChange={(e) => update("lifeYears", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>Tarifa base (COP/kWh)</label>
                <input type="number" value={activeScenario.tariff} onChange={(e) => update("tariff", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>Potencia FV (kW)</label>
                <input type="number" step="0.1" value={activeScenario.kW} onChange={(e) => update("kW", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>% autoconsumo (0–1)</label>
                <input type="number" step="0.01" value={activeScenario.selfConsumption} onChange={(e) => update("selfConsumption", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>CAPEX (COP)</label>
                <input type="number" value={activeScenario.capex} onChange={(e) => update("capex", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>O&amp;M anual (COP)</label>
                <input type="number" value={activeScenario.omAnnual} onChange={(e) => update("omAnnual", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>Tasa descuento</label>
                <input type="number" step="0.01" value={activeScenario.discountRate} onChange={(e) => update("discountRate", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>Escalamiento tarifa (anual)</label>
                <input type="number" step="0.01" value={activeScenario.tariffEscalation} onChange={(e) => update("tariffEscalation", Number(e.target.value))} />
              </div>

              <div className="field">
                <label>Incentivos tributarios (Colombia)</label>
                <select value={activeScenario.incentiveScheme} onChange={(e) => update("incentiveScheme", e.target.value)}>
                  {INCENTIVOS.map((x) => (
                    <option key={x.key} value={x.key}>{x.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="hr" />

            <div className="segment">
              <button className={`pill ${global.includeTaxBenefit ? "active" : ""}`}
                onClick={() => setGlobal((p) => ({ ...p, includeTaxBenefit: !p.includeTaxBenefit }))}>
                {global.includeTaxBenefit ? "✓" : " "} Incluir deducción renta (si aplica)
              </button>

              <button className={`pill ${global.useVolatility ? "active" : ""}`}
                onClick={() => setGlobal((p) => ({ ...p, useVolatility: !p.useVolatility }))}>
                {global.useVolatility ? "✓" : " "} Tarifa con volatilidad (estable)
              </button>

              <button className={`pill ${global.includeExports ? "active" : ""}`}
                onClick={() => setGlobal((p) => ({ ...p, includeExports: !p.includeExports }))}>
                {global.includeExports ? "✓" : " "} Considerar excedentes
              </button>
            </div>

            {engineer && (
              <>
                <div className="hr" />
                <h3 style={{ marginTop: 0 }}>Modo Ingeniero</h3>
                <div className="form">
                  <div className="field">
                    <label>PSH (h/día)</label>
                    <input type="number" step="0.1" value={activeScenario.psh} onChange={(e) => update("psh", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>PR (0–1)</label>
                    <input type="number" step="0.01" value={activeScenario.pr} onChange={(e) => update("pr", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>Degradación anual</label>
                    <input type="number" step="0.001" value={activeScenario.degAnnual} onChange={(e) => update("degAnnual", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>Precio excedentes (factor vs tarifa)</label>
                    <input type="number" step="0.01" value={activeScenario.exportFactor} onChange={(e) => update("exportFactor", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>IVA (simulación)</label>
                    <input type="number" step="0.01" value={activeScenario.ivaRate} onChange={(e) => update("ivaRate", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>Arancel (simulación)</label>
                    <input type="number" step="0.01" value={activeScenario.arancelRate} onChange={(e) => update("arancelRate", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>Tarifa de renta (simulación)</label>
                    <input type="number" step="0.01" value={activeScenario.taxRate} onChange={(e) => update("taxRate", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>Años deducción (simulación)</label>
                    <input type="number" value={activeScenario.deductionYears} onChange={(e) => update("deductionYears", Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label>Volatilidad tarifa (±)</label>
                    <input type="number" step="0.01" value={activeScenario.tariffVolatility} onChange={(e) => update("tariffVolatility", Number(e.target.value))} />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <div className="card">
            <h3>Gráfica comparativa</h3>
            <div className="small">Flujo acumulado por escenario (A/B/C).</div>

            <div style={{ height: 290, marginTop: 10 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 18, left: 6, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,.12)" strokeDasharray="3 3" />
                  <XAxis dataKey="year" stroke="rgba(234,241,255,.75)" />
                  <YAxis
                    stroke="rgba(234,241,255,.75)"
                    tickFormatter={(v) => {
                      const abs = Math.abs(v);
                      if (abs >= 1e9) return `${(v / 1e9).toFixed(1)} B`;
                      if (abs >= 1e6) return `${(v / 1e6).toFixed(0)} M`;
                      if (abs >= 1e3) return `${(v / 1e3).toFixed(0)} K`;
                      return `${v.toFixed(0)}`;
                    }}
                  />
                  <Tooltip formatter={(val) => [`$ ${fmtCOP(val)}`, "Acumulado"]} labelFormatter={(l) => `Año ${l}`} />
                  <Legend />
                  <Line type="monotone" dataKey="A" stroke="#22c55e" strokeWidth={2.6} dot={false} name="Acumulado A" />
                  <Line type="monotone" dataKey="B" stroke="#3b82f6" strokeWidth={2.6} dot={false} name="Acumulado B" />
                  <Line type="monotone" dataKey="C" stroke="#a855f7" strokeWidth={2.6} dot={false} name="Acumulado C" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="note">
              Nota PRO: volatilidad estable (no cambia sola). Excedentes dependen de reglas del OR.
            </div>
          </div>

          <div className="card">
            <h3>Viabilidad: Con vs Sin excedentes</h3>
            <div className="small">
              Comparación del escenario <b>{active}</b> ({activeScenario.name}) con excedentes y sin excedentes.
            </div>

            <div className="hr" />

            <div className="kpis">
              <div className="kpi">
                <div className="label">VPN (Con excedentes)</div>
                <div className="value green">$ {fmtCOP(modelWithExports.NPV)}</div>
              </div>
              <div className="kpi">
                <div className="label">VPN (Sin excedentes)</div>
                <div className="value green">$ {fmtCOP(modelNoExports.NPV)}</div>
              </div>
              <div className="kpi">
                <div className="label">TIR (Con excedentes)</div>
                <div className="value blue">{modelWithExports.IRR == null ? "—" : fmtPct(modelWithExports.IRR)}</div>
              </div>
              <div className="kpi">
                <div className="label">TIR (Sin excedentes)</div>
                <div className="value blue">{modelNoExports.IRR == null ? "—" : fmtPct(modelNoExports.IRR)}</div>
              </div>
            </div>

            <div className="note">
              Impacto excedentes en VPN (Con − Sin): <b>$ {fmtCOP(modelWithExports.NPV - modelNoExports.NPV)}</b><br/>
              Señal PRO (año 1): excedentes ~<b>{fmtPct(modelWithExports.exportShareY1)}</b> de ingresos.
            </div>
          </div>

          <div className="card">
            <h3>Conclusiones • Escenario {active} ({activeScenario.name})</h3>

            <div className="kpis">
              <div className="kpi">
                <div className="label">VPN (NPV)</div>
                <div className="value green">$ {fmtCOP(activeModel.NPV)}</div>
              </div>
              <div className="kpi">
                <div className="label">TIR (IRR)</div>
                <div className="value blue">{activeModel.IRR == null ? "—" : fmtPct(activeModel.IRR)}</div>
              </div>
              <div className="kpi">
                <div className="label">Payback</div>
                <div className="value">{activeModel.payback == null ? "—" : `${activeModel.payback} años`}</div>
              </div>
              <div className="kpi">
                <div className="label">ROI año 1</div>
                <div className="value">{fmtPct(activeModel.roi1)}</div>
              </div>
            </div>

            <div className="hr" />
            <ul className="list">
              {conclusions.map((c, i) => <li key={i}>{c}</li>)}
            </ul>

            <div className="note">
              CAPEX neto (con incentivos): <b>$ {fmtCOP(activeModel.capexNeto)}</b>
            </div>
          </div>
        </div>
      </div>

      {/* PDF report (oculto) */}
      <div className="reportWrap">
        <div className="report" ref={reportRef}>
          <h1>Smart Energy ROI v2.0 PRO • Reporte</h1>
          <div className="muted">
            Escenario {active} • {activeScenario.name} • COP • Simulación educativa
          </div>

          <div className="row">
            <div className="box">
              <div className="t">VPN</div>
              <div className="v">$ {fmtCOP(activeModel.NPV)}</div>
            </div>
            <div className="box">
              <div className="t">TIR</div>
              <div className="v">{activeModel.IRR == null ? "—" : fmtPct(activeModel.IRR)}</div>
            </div>
          </div>

          <div className="row">
            <div className="box">
              <div className="t">Con vs Sin excedentes</div>
              <div className="muted" style={{ marginTop: 8 }}>
                VPN con excedentes: <b>$ {fmtCOP(modelWithExports.NPV)}</b><br/>
                VPN sin excedentes: <b>$ {fmtCOP(modelNoExports.NPV)}</b><br/>
                Diferencia: <b>$ {fmtCOP(modelWithExports.NPV - modelNoExports.NPV)}</b><br/>
                % ingresos excedentes (año 1): <b>{fmtPct(modelWithExports.exportShareY1)}</b>
              </div>
            </div>
            <div className="box">
              <div className="t">Entradas principales</div>
              <div className="muted" style={{ marginTop: 8 }}>
                Potencia: <b>{activeScenario.kW} kW</b><br/>
                Tarifa: <b>{fmtCOP(activeScenario.tariff)} COP/kWh</b><br/>
                Autoconsumo: <b>{fmtPct(activeScenario.selfConsumption)}</b><br/>
                CAPEX bruto: <b>$ {fmtCOP(activeScenario.capex)}</b><br/>
                CAPEX neto: <b>$ {fmtCOP(activeModel.capexNeto)}</b>
              </div>
            </div>
          </div>

          <div className="row">
            <div className="box">
              <div className="t">Conclusiones</div>
              <ul>
                {conclusions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
            <div className="box">
              <div className="t">Nota</div>
              <div className="muted" style={{ marginTop: 8 }}>
                Reporte en fondo blanco para máxima legibilidad.
                Incentivos y excedentes son simulación educativa y dependen de requisitos reales.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
