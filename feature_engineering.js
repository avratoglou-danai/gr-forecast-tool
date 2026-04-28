// Feature engineering for the GR forecast ONNX model.
// NOTE: You MUST keep FEATURE_ORDER identical to the one used when exporting the ONNX model.

export const FEATURE_ORDER = [
  // Calendar engineered
  "dow", "month_num", "day_num", "weekofyear", "year_num",

  // Activations / levers (from Excel)
  "% Discount (sitewide)", "% Discount (category)", "Free Shipping",
  "PWP", "GWP", "Coupons", "Flat Disc", "KSM", "Holiday Season", "GWP Threshold",
  "Singles Day", "Black Friday",

  // Lags
  "orders_lag_1", "orders_lag_2", "orders_lag_7", "orders_lag_14", "orders_lag_28",
  "sales_lag_1", "sales_lag_2", "sales_lag_7", "sales_lag_14", "sales_lag_28",

  // Rolling
  "orders_roll_mean_7", "orders_roll_std_7", "orders_roll_mean_14", "orders_roll_std_14", "orders_roll_mean_28", "orders_roll_std_28",
  "sales_roll_mean_7", "sales_roll_std_7", "sales_roll_mean_14", "sales_roll_std_14", "sales_roll_mean_28", "sales_roll_std_28",

  // Interactions
  "disc_sitewide_x_ksm", "disc_cat_x_ksm", "flatdisc_x_ksm",
  "singles_x_disc_sitewide", "bf_x_disc_sitewide"
];

export function toISODate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function weekOfYear(date) {
  // ISO week number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil((((d - yearStart) / 86400000) + 1)/7);
}

export function normalizeRow(raw) {
  // Convert blanks to 0 for activation columns
  const z = (v) => (v === undefined || v === null || v === "") ? 0 : Number(v);

  return {
    date: raw.Date instanceof Date ? raw.Date : new Date(raw.Date),
    fy: raw.FY,
    actualOrders: raw.Orders !== undefined && raw.Orders !== null && raw.Orders !== "" ? Number(raw.Orders) : NaN,
    actualSales: raw.Sales !== undefined && raw.Sales !== null && raw.Sales !== "" ? Number(raw.Sales) : NaN,

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
    blackFriday: z(raw["Black Friday"])
  };
}

export function addCalendarFeatures(row) {
  const d = row.date;
  const dow = (d.getDay() + 6) % 7; // 0=Mon
  return {
    ...row,
    dow,
    month_num: d.getMonth() + 1,
    day_num: d.getDate(),
    weekofyear: weekOfYear(d),
    year_num: d.getFullYear()
  };
}

export function computeLagRolling(history, idx) {
  // history: array of rows with actual/pred filled for past
  // idx: current index
  const getVal = (i, keyActual, keyPred) => {
    if (i < 0) return NaN;
    const r = history[i];
    // prefer actual if exists, else predicted
    const a = r[keyActual];
    if (isFinite(a)) return a;
    const p = r[keyPred];
    return isFinite(p) ? p : NaN;
  };

  const orders_lag_1  = getVal(idx-1,  'actualOrders','predOrders');
  const orders_lag_2  = getVal(idx-2,  'actualOrders','predOrders');
  const orders_lag_7  = getVal(idx-7,  'actualOrders','predOrders');
  const orders_lag_14 = getVal(idx-14, 'actualOrders','predOrders');
  const orders_lag_28 = getVal(idx-28, 'actualOrders','predOrders');

  const sales_lag_1  = getVal(idx-1,  'actualSales','predSales');
  const sales_lag_2  = getVal(idx-2,  'actualSales','predSales');
  const sales_lag_7  = getVal(idx-7,  'actualSales','predSales');
  const sales_lag_14 = getVal(idx-14, 'actualSales','predSales');
  const sales_lag_28 = getVal(idx-28, 'actualSales','predSales');

  function rollStats(win, keyA, keyP) {
    const vals = [];
    for (let j = idx-1; j >= 0 && j >= idx-win; j--) {
      const v = getVal(j, keyA, keyP);
      if (isFinite(v)) vals.push(v);
    }
    if (!vals.length) return { mean: NaN, std: NaN };
    const mean = vals.reduce((s,x)=>s+x,0) / vals.length;
    const variance = vals.length > 1 ? vals.reduce((s,x)=>s+(x-mean)*(x-mean),0)/(vals.length-1) : 0;
    return { mean, std: Math.sqrt(variance) };
  }

  const o7  = rollStats(7,  'actualOrders','predOrders');
  const o14 = rollStats(14, 'actualOrders','predOrders');
  const o28 = rollStats(28, 'actualOrders','predOrders');

  const s7  = rollStats(7,  'actualSales','predSales');
  const s14 = rollStats(14, 'actualSales','predSales');
  const s28 = rollStats(28, 'actualSales','predSales');

  return {
    orders_lag_1, orders_lag_2, orders_lag_7, orders_lag_14, orders_lag_28,
    sales_lag_1,  sales_lag_2,  sales_lag_7,  sales_lag_14,  sales_lag_28,

    orders_roll_mean_7:  o7.mean,  orders_roll_std_7:  o7.std,
    orders_roll_mean_14: o14.mean, orders_roll_std_14: o14.std,
    orders_roll_mean_28: o28.mean, orders_roll_std_28: o28.std,

    sales_roll_mean_7:  s7.mean,  sales_roll_std_7:  s7.std,
    sales_roll_mean_14: s14.mean, sales_roll_std_14: s14.std,
    sales_roll_mean_28: s28.mean, sales_roll_std_28: s28.std,
  };
}

export function buildFeatureVector(row, lagRoll) {
  // Interactions
  const disc_sitewide_x_ksm = row.discSite * row.ksm;
  const disc_cat_x_ksm = row.discCat * row.ksm;
  const flatdisc_x_ksm = row.flatDisc * row.ksm;
  const singles_x_disc_sitewide = row.singlesDay * row.discSite;
  const bf_x_disc_sitewide = row.blackFriday * row.discSite;

  const featureMap = {
    dow: row.dow,
    month_num: row.month_num,
    day_num: row.day_num,
    weekofyear: row.weekofyear,
    year_num: row.year_num,

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

    ...lagRoll,

    disc_sitewide_x_ksm,
    disc_cat_x_ksm,
    flatdisc_x_ksm,
    singles_x_disc_sitewide,
    bf_x_disc_sitewide
  };

  return FEATURE_ORDER.map(k => {
    const v = featureMap[k];
    return (v === undefined || v === null || !isFinite(v)) ? 0 : Number(v);
  });
}
