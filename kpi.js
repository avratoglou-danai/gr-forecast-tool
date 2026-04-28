// KPI + Orders-based GOOD/OK/BAD gate

function safeDiv(a, b, eps = 1e-9) {
  return a / (Math.abs(b) < eps ? eps : b);
}

export function metrics(actual, pred) {
  const n = Math.min(actual.length, pred.length);
  let absErrSum = 0, absPctErrSum = 0, errSum = 0, actSum = 0;
  let dirCorrect = 0, dirCount = 0;

  for (let i = 0; i < n; i++) {
    const a = actual[i], p = pred[i];
    if (!isFinite(a) || !isFinite(p)) continue;

    const err = a - p;
    absErrSum += Math.abs(err);
    errSum += err;
    actSum += Math.abs(a);

    absPctErrSum += Math.abs(err) / Math.max(Math.abs(a), 1e-6);

    if (i > 0 && isFinite(actual[i - 1]) && isFinite(pred[i - 1])) {
      const da = Math.sign(a - actual[i - 1]);
      const dp = Math.sign(p - pred[i - 1]);
      dirCorrect += (da === dp) ? 1 : 0;
      dirCount++;
    }
  }

  return {
    n,
    mape: safeDiv(absPctErrSum, n),
    wmape: safeDiv(absErrSum, actSum),
    bias: safeDiv(errSum, actSum),
    dirAcc: dirCount ? (dirCorrect / dirCount) : NaN
  };
}

export function splitByEvent(rows) {
  const event = [], nonEvent = [];
  for (const r of rows) {
    const isEvent = (r.singlesDay === 1) || (r.blackFriday === 1);
    (isEvent ? event : nonEvent).push(r);
  }
  return { event, nonEvent };
}

export const TH_ORDERS = {
  wmape_good: 0.25,
  wmape_ok: 0.35,
  bias_good: 0.10,
  bias_ok: 0.15,
  nonevent_wmape_ok: 0.30,
  dir_ok: 0.50
};

export function ordersVerdict(kpiOrders60, kpiOrders60NonEvent, thresholds = TH_ORDERS) {
  const w = kpiOrders60.wmape;
  const b = Math.abs(kpiOrders60.bias);
  const wNE = kpiOrders60NonEvent ? kpiOrders60NonEvent.wmape : w;
  const dirBad = isFinite(kpiOrders60.dirAcc) && kpiOrders60.dirAcc < thresholds.dir_ok;

  if (w > thresholds.wmape_ok) return "BAD";
  if (b > thresholds.bias_ok && wNE > thresholds.nonevent_wmape_ok) return "BAD";

  if (w > thresholds.wmape_good) return "OK";
  if (b > thresholds.bias_good) return "OK";
  if (dirBad) return "OK";

  return "GOOD";
}

export function evaluateOrdersQuality(rows) {
  const evalRows = rows.filter(r => isFinite(r.actualOrders) && isFinite(r.predOrders));
  const last60 = evalRows.slice(-60);
  const { event, nonEvent } = splitByEvent(last60);

  const kpiAll = metrics(evalRows.map(r => r.actualOrders), evalRows.map(r => r.predOrders));
  const kpi60  = metrics(last60.map(r => r.actualOrders),  last60.map(r => r.predOrders));
  const kpi60E  = event.length ? metrics(event.map(r => r.actualOrders), event.map(r => r.predOrders)) : null;
  const kpi60NE = nonEvent.length ? metrics(nonEvent.map(r => r.actualOrders), nonEvent.map(r => r.predOrders)) : null;

  const verdict = ordersVerdict(kpi60, kpi60NE, TH_ORDERS);

  return { verdict, kpis: { all: kpiAll, last60: kpi60, event: kpi60E, nonEvent: kpi60NE } };
}
