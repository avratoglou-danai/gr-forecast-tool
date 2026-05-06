/* GR Forecast Tool - FINAL app.js (v34)
   - Global scripts (no modules)
   - Auto-load model from models/model.onnx
   - Handles Excel serial dates (e.g. 45108)
   - Sends EXACTLY 34 features to ONNX (Expected=34)
*/

(function () {
  const APP_VERSION = "v34-2026-04-28";

  // Elements
  const fileInput = document.getElementById("fileInput");
  const modeSelect = document.getElementById("mode");
  const scenarioBlock = document.getElementById("scenarioBlock");
  const horizonInput = document.getElementById("horizon");
  const runBtn = document.getElementById("runBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const statusEl = document.getElementById("status");

  const verdictBadge = document.getElementById("verdictBadge");
  const wmape60El = document.getElementById("wmape60");
  const bias60El = document.getElementById("bias60");
  const wmape60NEEl = document.getElementById("wmape60NE");
  const wmape60EEl = document.getElementById("wmape60E");
  const healthNoteEl = document.getElementById("healthNote");

  const tableBody = document.querySelector("#resultsTable tbody");

  // State
  let workbookRows = null;
  let rows = null;
  let session = null;
  let modelReady = false;
  let excelReady = false;
  let lastResults = null;

  // Config
  const MODEL_URL = "models/model.onnx";

  // EXACT 34 features (matches your ONNX)
  const FEATURE_ORDER = [
    // Calendar (5)
    "dow", "month_num", "day_num", "weekofyear", "year_num",

    // Activations (12)
    "% Discount (sitewide)", "% Discount (category)", "Free Shipping",
    "PWP", "GWP", "Coupons", "Flat Disc", "KSM",
    "Holiday Season", "GWP Threshold", "Singles Day", "Black Friday",

    // Lags (8)
    "orders_lag_1", "orders_lag_7", "orders_lag_14", "orders_lag_28",
    "sales_lag_1", "sales_lag_7", "sales_lag_14", "sales_lag_28",

    // Rolling means only (6)
    "orders_roll_mean_7", "orders_roll_mean_14", "orders_roll_mean_28",
    "sales_roll_mean_7", "sales_roll_mean_14", "sales_roll_mean_28",

    // Interactions (3)
    "disc_sitewide_x_ksm",
    "singles_x_disc_sitewide",
    "bf_x_disc_sitewide"
  ];

  // expose for debugging
  window.APP_VERSION = APP_VERSION;
  window.FEATURE_ORDER = FEATURE_ORDER;
  console.log("GR Forecast Tool loaded:", APP_VERSION, "features=", FEATURE_ORDER.length);

  const TH = {
    wmape_good: 0.25,
    wmape_ok: 0.35,
    bias_good: 0.10,
    bias_ok: 0.15,
    nonevent_wmape_ok: 0.30,
    dir_ok: 0.50
  };

  function setStatus(msg) {
    statusEl.textContent = `[${APP_VERSION}] ${msg}`;
  }

  function fmtPct(x) {
    if (!isFinite(x)) return "—";
    return (x * 100).toFixed(1) + "%";
  }

  function fmtNum(x, digits = 0) {
    if (!isFinite(x)) return "—";
    return Number(x).toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function toISODate(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function safeDiv(a, b, eps = 1e-9) {
    return a / (Math.abs(b) < eps ? eps : b);
  }

  function enableRunIfReady() {
    runBtn.disabled = !(modelReady && excelReady);
  }

  function updateScenarioVisibility() {
    if (!scenarioBlock) return;
    if (modeSelect.value === "scenario") scenarioBlock.classList.remove("hidden");
    else scenarioBlock.classList.add("hidden");
  }

  // KPI
  function metrics(actual, pred) {
    const n = Math.min(actual.length, pred.length);
    let absErrSum = 0, errSum = 0, actSum = 0;
    let dirCorrect = 0, dirCount = 0;

    for (let i = 0; i < n; i++) {
      const a = actual[i], p = pred[i];
      if (!isFinite(a) || !isFinite(p)) continue;
      const err = a - p;
      absErrSum += Math.abs(err);
      errSum += err;
      actSum += Math.abs(a);
      if (i > 0 && isFinite(actual[i - 1]) && isFinite(pred[i - 1])) {
        const da = Math.sign(a - actual[i - 1]);
        const dp = Math.sign(p - pred[i - 1]);
        dirCorrect += (da === dp) ? 1 : 0;
        dirCount++;
      }
    }

    return {
      wmape: safeDiv(absErrSum, actSum),
      bias: safeDiv(errSum, actSum),
      dirAcc: dirCount ? (dirCorrect / dirCount) : NaN
    };
  }

  function splitByEvent(rowsArr) {
    const event = [], nonEvent = [];
    for (const r of rowsArr) {
      const isEvent = (r.singlesDay === 1) || (r.blackFriday === 1);
      (isEvent ? event : nonEvent).push(r);
    }
    return { event, nonEvent };
  }

  function ordersVerdict(kpi60, kpi60NE) {
    const w = kpi60.wmape;
    const b = Math.abs(kpi60.bias);
    const wNE = kpi60NE ? kpi60NE.wmape : w;
    const dirBad = isFinite(kpi60.dirAcc) && kpi60.dirAcc < TH.dir_ok;

    if (w > TH.wmape_ok) return "BAD";
    if (b > TH.bias_ok && wNE > TH.nonevent_wmape_ok) return "BAD";

    if (w > TH.wmape_good) return "OK";
    if (b > TH.bias_good) return "OK";
    if (dirBad) return "OK";

    return "GOOD";
  }

  function setVerdictUI(verdict) {
    verdictBadge.textContent = verdict;
    verdictBadge.className = "badge " + (verdict === "GOOD" ? "good" : verdict === "OK" ? "ok" : verdict === "BAD" ? "bad" : "");
  }

  function computeQuality(allRows) {
    const evalRows = allRows.filter(r => isFinite(r.actualOrders) && isFinite(r.predOrders));
    const last60 = evalRows.slice(-60);
    const { event, nonEvent } = splitByEvent(last60);

    const k60 = metrics(last60.map(r => r.actualOrders), last60.map(r => r.predOrders));
    const kE = event.length ? metrics(event.map(r => r.actualOrders), event.map(r => r.predOrders)) : null;
    const kNE = nonEvent.length ? metrics(nonEvent.map(r => r.actualOrders), nonEvent.map(r => r.predOrders)) : null;

    const verdict = ordersVerdict(k60, kNE);
    return { verdict, k60, kE, kNE };
  }

  // Excel
  async function loadExcel(file) {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: "array", cellDates: true });
    const sheet = wb.Sheets["0_Source_Forecast"]; 
    if (!sheet) throw new Error('Sheet "0_Source_Forecast" not found');
    return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  }

  function weekOfYear(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  function z(v) {
    if (v === undefined || v === null || v === "") return 0;
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function parseExcelDate(val) {
    if (val instanceof Date) return val;
    if (typeof val === "number") {
      const p = XLSX.SSF.parse_date_code(val);
      if (p) return new Date(p.y, p.m - 1, p.d);
    }
    return new Date(val);
  }

  function normalizeRow(raw) {
    const date = parseExcelDate(raw.Date);

    return {
      date,
      actualOrders: raw.Orders !== "" && raw.Orders !== null && raw.Orders !== undefined ? Number(raw.Orders) : NaN,
      actualSales: raw.Sales !== "" && raw.Sales !== null && raw.Sales !== undefined ? Number(raw.Sales) : NaN,

      discSite: z(raw["% Discount (sitewide)"]),
      discCat: z(raw["% Discount (category)"]),
      freeShip: z(raw["Free Shipping"]),
      pwp: z(raw["PWP"]),
      gwp: z(raw["GWP"]),
      coupons: z(raw["Coupons"]),
      flatDisc: z(raw["Flat Disc"]),
      ksm: z(raw["KSM"]),
      holiday: z(raw["Holiday Season"]),
      gwpThr: z(raw["GWP Threshold"]),
      singlesDay: z(raw["Singles Day"]),
      blackFriday: z(raw["Black Friday"]),

      predOrders: NaN,
      predSales: NaN,
    };
  }

  function addCalendar(row) {
    const d = row.date;
    const dow = (d.getDay() + 6) % 7; // 0=Mon
    return {
      ...row,
      dow,
      month_num: d.getMonth() + 1,
      day_num: d.getDate(),
      weekofyear: weekOfYear(d),
      year_num: d.getFullYear(),
    };
  }

  function buildTimeline(rawRows) {
    const arr = rawRows.map(normalizeRow).map(addCalendar);
    arr.sort((a, b) => a.date - b.date);
    return arr;
  }

  function getVal(history, i, keyActual, keyPred) {
    if (i < 0) return NaN;
    const r = history[i];
    const a = r[keyActual];
    if (isFinite(a)) return a;
    const p = r[keyPred];
    return isFinite(p) ? p : NaN;
  }

  function rollMean(history, idx, win, keyA, keyP) {
    const vals = [];
    for (let j = idx - 1; j >= 0 && j >= idx - win; j--) {
      const v = getVal(history, j, keyA, keyP);
      if (isFinite(v)) vals.push(v);
    }
    if (!vals.length) return NaN;
    return vals.reduce((s, x) => s + x, 0) / vals.length;
  }

  function buildFeatureVector(row, history, idx) {
    const featureMap = {
      // calendar
      dow: row.dow,
      month_num: row.month_num,
      day_num: row.day_num,
      weekofyear: row.weekofyear,
      year_num: row.year_num,

      // activations
      "% Discount (sitewide)": row.discSite,
      "% Discount (category)": row.discCat,
      "Free Shipping": row.freeShip,
      "PWP": row.pwp,
      "GWP": row.gwp,
      "Coupons": row.coupons,
      "Flat Disc": row.flatDisc,
      "KSM": row.ksm,
      "Holiday Season": row.holiday,
      "GWP Threshold": row.gwpThr,
      "Singles Day": row.singlesDay,
      "Black Friday": row.blackFriday,

      // lags (1/7/14/28)
      orders_lag_1: getVal(history, idx - 1, "actualOrders", "predOrders"),
      orders_lag_7: getVal(history, idx - 7, "actualOrders", "predOrders"),
      orders_lag_14: getVal(history, idx - 14, "actualOrders", "predOrders"),
      orders_lag_28: getVal(history, idx - 28, "actualOrders", "predOrders"),

      sales_lag_1: getVal(history, idx - 1, "actualSales", "predSales"),
      sales_lag_7: getVal(history, idx - 7, "actualSales", "predSales"),
      sales_lag_14: getVal(history, idx - 14, "actualSales", "predSales"),
      sales_lag_28: getVal(history, idx - 28, "actualSales", "predSales"),

      // rolling means (7/14/28)
      orders_roll_mean_7: rollMean(history, idx, 7, "actualOrders", "predOrders"),
      orders_roll_mean_14: rollMean(history, idx, 14, "actualOrders", "predOrders"),
      orders_roll_mean_28: rollMean(history, idx, 28, "actualOrders", "predOrders"),

      sales_roll_mean_7: rollMean(history, idx, 7, "actualSales", "predSales"),
      sales_roll_mean_14: rollMean(history, idx, 14, "actualSales", "predSales"),
      sales_roll_mean_28: rollMean(history, idx, 28, "actualSales", "predSales"),

      // interactions
      disc_sitewide_x_ksm: row.discSite * row.ksm,
      singles_x_disc_sitewide: row.singlesDay * row.discSite,
      bf_x_disc_sitewide: row.blackFriday * row.discSite,
    };

    const vec = FEATURE_ORDER.map(k => {
      const v = featureMap[k];
      return (v === undefined || v === null || !isFinite(v)) ? 0 : Number(v);
    });

    return vec;
  }

  function extendFuture(history, days) {
    const last = history[history.length - 1];
    const out = history.slice();
    for (let k = 1; k <= days; k++) {
      const d = new Date(last.date);
      d.setDate(d.getDate() + k);
      const r = addCalendar({
        ...last,
        date: d,
        actualOrders: NaN,
        actualSales: NaN,
        predOrders: NaN,
        predSales: NaN,
      });
      out.push(r);
    }
    return out;
  }

  async function loadModel() {
    try {
      if (!window.ort || !window.ort.InferenceSession) {
        throw new Error("onnxruntime-web not loaded. Check index.html script order.");
      }
      setStatus("Loading model…");
      session = await window.ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
      modelReady = true;
      setStatus("Model loaded. Upload your Excel to begin.");
      enableRunIfReady();
    } catch (err) {
      console.error(err);
      modelReady = false;
      setStatus("Error loading model: " + err.message);
      enableRunIfReady();
    }
  }

  async function predictRange(timeline, startIdx, endIdx) {
    const ort = window.ort;
    const inputName = session.inputNames[0];
    const outputNames = session.outputNames;

    for (let i = startIdx; i < endIdx; i++) {
      const features = buildFeatureVector(timeline[i], timeline, i);
      if (features.length !== FEATURE_ORDER.length) {
        throw new Error(`Feature length mismatch: got ${features.length}, expected ${FEATURE_ORDER.length}`);
      }

      const tensor = new ort.Tensor("float32", Float32Array.from(features), [1, features.length]);
      const feeds = { [inputName]: tensor };
      const results = await session.run(feeds);

      let predOrders, predSales;
      if (outputNames.length === 1) {
        const out = results[outputNames[0]].data;
        predOrders = out[0];
        predSales = out[1];
      } else {
        predOrders = results[outputNames[0]].data[0];
        predSales = results[outputNames[1]].data[0];
      }

      timeline[i].predOrders = predOrders;
      timeline[i].predSales = predSales;
    }
  }

  function renderTable(timeline) {
    tableBody.innerHTML = "";
    const frag = document.createDocumentFragment();

    for (const r of timeline) {
      const tr = document.createElement("tr");

      const oe = (isFinite(r.actualOrders) && isFinite(r.predOrders) && r.actualOrders !== 0)
        ? Math.abs(r.actualOrders - r.predOrders) / Math.abs(r.actualOrders)
        : NaN;

      const se = (isFinite(r.actualSales) && isFinite(r.predSales) && r.actualSales !== 0)
        ? Math.abs(r.actualSales - r.predSales) / Math.abs(r.actualSales)
        : NaN;

      tr.innerHTML = `
        <td>${toISODate(r.date)}</td>
        <td>${fmtNum(r.actualOrders, 0)}</td>
        <td>${fmtNum(r.predOrders, 0)}</td>
        <td>${fmtPct(oe)}</td>
        <td>${fmtNum(r.actualSales, 0)}</td>
        <td>${fmtNum(r.predSales, 0)}</td>
        <td>${fmtPct(se)}</td>
        <td>${r.singlesDay ? 1 : 0}</td>
        <td>${r.blackFriday ? 1 : 0}</td>
      `;
      frag.appendChild(tr);
    }

    tableBody.appendChild(frag);
  }

  function toCSV(timeline) {
    const header = [
      "Date", "Actual_Orders", "Pred_Orders", "Orders_Pct_Error",
      "Actual_Sales", "Pred_Sales", "Sales_Pct_Error",
      "Singles_Day", "Black_Friday"
    ];

    const lines = [header.join(",")];

    for (const r of timeline) {
      const oe = (isFinite(r.actualOrders) && isFinite(r.predOrders) && r.actualOrders !== 0)
        ? (Math.abs(r.actualOrders - r.predOrders) / Math.abs(r.actualOrders))
        : "";

      const se = (isFinite(r.actualSales) && isFinite(r.predSales) && r.actualSales !== 0)
        ? (Math.abs(r.actualSales - r.predSales) / Math.abs(r.actualSales))
        : "";

      lines.push([
        toISODate(r.date),
        isFinite(r.actualOrders) ? r.actualOrders : "",
        isFinite(r.predOrders) ? r.predOrders : "",
        oe,
        isFinite(r.actualSales) ? r.actualSales : "",
        isFinite(r.predSales) ? r.predSales : "",
        se,
        r.singlesDay ? 1 : 0,
        r.blackFriday ? 1 : 0
      ].join(","));
    }

    return lines.join("
");
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Events
  fileInput.addEventListener("change", async (e) => {
    try {
      const f = e.target.files && e.target.files[0];
      if (!f) return;

      setStatus("Reading Excel…");
      workbookRows = await loadExcel(f);
      rows = buildTimeline(workbookRows);

      excelReady = true;
      setStatus(modelReady ? "Excel loaded. Ready to run forecast." : "Excel loaded. Waiting for model…");
      enableRunIfReady();

    } catch (err) {
      console.error(err);
      excelReady = false;
      setStatus("Error reading Excel: " + err.message);
      enableRunIfReady();
    }
  });

  runBtn.addEventListener("click", async () => {
    try {
      runBtn.disabled = true;
      downloadBtn.disabled = true;

      const mode = modeSelect.value;
      const horizon = Number((horizonInput && horizonInput.value) || 28);

      const startIdx = rows.findIndex(r => !isFinite(r.actualOrders));
      const start = (startIdx === -1) ? rows.length : startIdx;

      let timeline = rows;

      if (mode === "rolling") {
        if (timeline.length < start + 7) timeline = extendFuture(timeline, (start + 7) - timeline.length);
        setStatus("Running rolling forecast (next 7 days)…");
        await predictRange(timeline, start, start + 7);
      } else {
        const end = start + horizon;
        if (timeline.length < end) timeline = extendFuture(timeline, end - timeline.length);
        setStatus(`Running scenario forecast (${horizon} days)…`);
        await predictRange(timeline, start, end);
      }

      const q = computeQuality(timeline);
      setVerdictUI(q.verdict);

      wmape60El.textContent = fmtPct(q.k60.wmape);
      bias60El.textContent = fmtPct(q.k60.bias);
      wmape60NEEl.textContent = q.kNE ? fmtPct(q.kNE.wmape) : "—";
      wmape60EEl.textContent = q.kE ? fmtPct(q.kE.wmape) : "—";
      healthNoteEl.textContent = "Verdict is Orders-based (last 60 days with actual Orders). Event days use Singles Day / Black Friday flags.";

      renderTable(timeline);

      lastResults = timeline;
      downloadBtn.disabled = false;
      setStatus("Done.");

    } catch (err) {
      console.error(err);
      setStatus("Error running forecast: " + err.message);
    } finally {
      enableRunIfReady();
    }
  });

  downloadBtn.addEventListener("click", () => {
    if (!lastResults) return;
    const csv = toCSV(lastResults);
    downloadText("gr_forecast_results.csv", csv);
  });

  // Init
  modeSelect.addEventListener("change", updateScenarioVisibility);
  updateScenarioVisibility();
  setVerdictUI("—");
  enableRunIfReady();
  loadModel();
})();
