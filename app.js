import { evaluateOrdersQuality } from "./kpi.js";
import { normalizeRow, addCalendarFeatures, computeLagRolling, buildFeatureVector, toISODate } from "./feature_engineering.js";

const els = {
  fileInput: document.getElementById('fileInput'),
  modelInput: document.getElementById('modelInput'),
  mode: document.getElementById('mode'),
  horizon: document.getElementById('horizon'),
  runBtn: document.getElementById('runBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  status: document.getElementById('status'),
  tableBody: document.querySelector('#resultsTable tbody'),

  verdictBadge: document.getElementById('verdictBadge'),
  wmape60: document.getElementById('wmape60'),
  bias60: document.getElementById('bias60'),
  wmape60NE: document.getElementById('wmape60NE'),
  wmape60E: document.getElementById('wmape60E'),
  healthNote: document.getElementById('healthNote')
};

let workbookRows = null;
let session = null;
let lastResults = null;

function setStatus(msg) {
  els.status.textContent = msg;
}

function fmtPct(x) {
  if (!isFinite(x)) return '—';
  return (x * 100).toFixed(1) + '%';
}

function fmtNum(x, digits=0) {
  if (!isFinite(x)) return '—';
  return Number(x).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function setVerdict(verdict) {
  els.verdictBadge.textContent = verdict;
  els.verdictBadge.className = 'badge ' + (verdict === 'GOOD' ? 'good' : verdict === 'OK' ? 'ok' : verdict === 'BAD' ? 'bad' : '');
}

async function loadExcel(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets['0_Source_Forecast'];
  if (!sheet) throw new Error('Sheet "0_Source_Forecast" not found');
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return json;
}

async function loadOnnxFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Use global ort from CDN module
  const ort = window.ort;
  if (!ort) throw new Error('onnxruntime-web not loaded');
  // WASM backend by default
  return await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

function enableRunIfReady() {
  els.runBtn.disabled = !(workbookRows && session);
}

function renderTable(rows) {
  els.tableBody.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const r of rows) {
    const tr = document.createElement('tr');

    const pctErrOrders = (isFinite(r.actualOrders) && isFinite(r.predOrders) && r.actualOrders !== 0)
      ? Math.abs(r.actualOrders - r.predOrders) / Math.abs(r.actualOrders)
      : NaN;

    const pctErrSales = (isFinite(r.actualSales) && isFinite(r.predSales) && r.actualSales !== 0)
      ? Math.abs(r.actualSales - r.predSales) / Math.abs(r.actualSales)
      : NaN;

    tr.innerHTML = `
      <td>${toISODate(r.date)}</td>
      <td>${fmtNum(r.actualOrders, 0)}</td>
      <td>${fmtNum(r.predOrders, 0)}</td>
      <td>${fmtPct(pctErrOrders)}</td>
      <td>${fmtNum(r.actualSales, 0)}</td>
      <td>${fmtNum(r.predSales, 0)}</td>
      <td>${fmtPct(pctErrSales)}</td>
      <td>${r.singlesDay ? '1' : '0'}</td>
      <td>${r.blackFriday ? '1' : '0'}</td>
    `;

    frag.appendChild(tr);
  }
  els.tableBody.appendChild(frag);
}

function buildForecastRows(rawRows) {
  const rows = rawRows.map(normalizeRow).map(addCalendarFeatures);
  // Ensure sorted by date
  rows.sort((a,b) => a.date - b.date);
  return rows;
}

async function predictForRows(rows, startIndex, endIndex) {
  // Predict for rows[startIndex...endIndex-1] using lag/rolling computed from history.
  for (let i = startIndex; i < endIndex; i++) {
    const lagRoll = computeLagRolling(rows, i);
    const features = buildFeatureVector(rows[i], lagRoll);

    // Create tensor [1, numFeatures]
    const ort = window.ort;
    const inputName = session.inputNames[0];
    const outputNames = session.outputNames;

    const tensor = new ort.Tensor('float32', Float32Array.from(features), [1, features.length]);
    const feeds = { [inputName]: tensor };

    const results = await session.run(feeds);

    // Assumption: model outputs 2 values (predOrders, predSales) in one output or 2 outputs.
    // You may need to adjust mapping based on your exported model outputs.
    let predOrders, predSales;

    if (outputNames.length === 1) {
      const out = results[outputNames[0]].data;
      predOrders = out[0];
      predSales = out[1];
    } else {
      predOrders = results[outputNames[0]].data[0];
      predSales  = results[outputNames[1]].data[0];
    }

    rows[i].predOrders = predOrders;
    rows[i].predSales = predSales;
  }
}

function extendRowsForHorizon(rows, horizonDays) {
  // Create future rows for scenario forecast.
  // IMPORTANT: future activation plan should be provided in the Excel for those future dates.
  // Here, we simply extend using the last row's activations as a placeholder.

  const last = rows[rows.length - 1];
  const future = [];

  for (let k = 1; k <= horizonDays; k++) {
    const d = new Date(last.date);
    d.setDate(d.getDate() + k);

    const r = {
      ...last,
      date: d,
      actualOrders: NaN,
      actualSales: NaN,
      // Keep same levers by default; user should overwrite via future rows in Excel for true scenario.
    };
    future.push(addCalendarFeatures(r));
  }

  return rows.concat(future);
}

function toCSV(rows) {
  const header = [
    'Date','Actual_Orders','Pred_Orders','Orders_Pct_Error','Actual_Sales','Pred_Sales','Sales_Pct_Error','Singles_Day','Black_Friday'
  ];

  const lines = [header.join(',')];

  for (const r of rows) {
    const oe = (isFinite(r.actualOrders) && isFinite(r.predOrders) && r.actualOrders !== 0) ? (Math.abs(r.actualOrders - r.predOrders) / Math.abs(r.actualOrders)) : '';
    const se = (isFinite(r.actualSales) && isFinite(r.predSales) && r.actualSales !== 0) ? (Math.abs(r.actualSales - r.predSales) / Math.abs(r.actualSales)) : '';

    lines.push([
      toISODate(r.date),
      isFinite(r.actualOrders) ? r.actualOrders : '',
      isFinite(r.predOrders) ? r.predOrders : '',
      oe,
      isFinite(r.actualSales) ? r.actualSales : '',
      isFinite(r.predSales) ? r.predSales : '',
      se,
      r.singlesDay ? 1 : 0,
      r.blackFriday ? 1 : 0
    ].join(','));
  }

  return lines.join('\n');
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Wire UI
els.fileInput.addEventListener('change', async (e) => {
  try {
    const f = e.target.files?.[0];
    if (!f) return;
    setStatus('Reading Excel...');
    workbookRows = await loadExcel(f);
    setStatus(`Loaded ${workbookRows.length} rows from Excel.`);
    enableRunIfReady();
  } catch (err) {
    console.error(err);
    setStatus('Error reading Excel: ' + err.message);
  }
});

els.modelInput.addEventListener('change', async (e) => {
  try {
    const f = e.target.files?.[0];
    if (!f) return;
    setStatus('Loading ONNX model...');
    session = await loadOnnxFromFile(f);
    setStatus('ONNX model loaded.' );
    enableRunIfReady();
  } catch (err) {
    console.error(err);
    setStatus('Error loading model: ' + err.message);
  }
});

els.runBtn.addEventListener('click', async () => {
  try {
    els.runBtn.disabled = true;
    els.downloadBtn.disabled = true;
    setStatus('Preparing rows...');

    let rows = buildForecastRows(workbookRows);

    const mode = els.mode.value;
    const horizonDays = Number(els.horizon.value || 28);

    // Determine where "future" starts: first row with missing actualOrders
    const firstMissing = rows.findIndex(r => !isFinite(r.actualOrders));
    const startIdx = (firstMissing === -1) ? rows.length : firstMissing;

    if (mode === 'rolling') {
      // Predict next 7 days: requires those future dates exist in Excel or we extend them.
      // If no future rows exist, extend by 7 with last-row levers as placeholders.
      const needed = startIdx + 7;
      if (rows.length < needed) rows = extendRowsForHorizon(rows, needed - rows.length);

      setStatus('Running rolling forecast (next 7 days)...');
      await predictForRows(rows, startIdx, startIdx + 7);

    } else {
      // Scenario: extend to horizonDays beyond last actual day if not present.
      const desiredEnd = startIdx + horizonDays;
      if (rows.length < desiredEnd) rows = extendRowsForHorizon(rows, desiredEnd - rows.length);

      setStatus(`Running scenario forecast (${horizonDays} days)...`);
      await predictForRows(rows, startIdx, desiredEnd);
    }

    // Evaluate Orders-based quality (only where actuals exist)
    const quality = evaluateOrdersQuality(rows);
    setVerdict(quality.verdict);

    // Populate KPI cards
    const k60 = quality.kpis.last60;
    const kNE = quality.kpis.nonEvent;
    const kE  = quality.kpis.event;

    els.wmape60.textContent = fmtPct(k60.wmape);
    els.bias60.textContent  = fmtPct(k60.bias);
    els.wmape60NE.textContent = kNE ? fmtPct(kNE.wmape) : '—';
    els.wmape60E.textContent  = kE ? fmtPct(kE.wmape) : '—';

    els.healthNote.textContent =
      `Verdict is Orders-based and computed on the last 60 days with actual Orders. ` +
      `Event days are flagged using Singles Day / Black Friday.`;

    // Render table
    renderTable(rows);

    lastResults = rows;
    els.downloadBtn.disabled = false;
    setStatus('Done.');

  } catch (err) {
    console.error(err);
    setStatus('Error running forecast: ' + err.message);
  } finally {
    els.runBtn.disabled = !(workbookRows && session);
  }
});

els.downloadBtn.addEventListener('click', () => {
  if (!lastResults) return;
  const csv = toCSV(lastResults);
  downloadText('gr_forecast_results.csv', csv);
});

setVerdict('—');
