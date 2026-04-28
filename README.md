# gr-forecast-tool

A **GitHub Pages** (static) web app for running **in-browser forecasts** (Orders + Sales) using an **ONNX** model and showing an **Orders-based model health verdict** (GOOD / OK / BAD). 

## Why this works on GitHub Pages
GitHub Pages serves static files (HTML/CSS/JS). The tool runs inference **client-side in the browser** using `onnxruntime-web` (WebAssembly). GitHub Pages itself does not execute server-side code. 

References:
- GitHub Pages is static hosting with usage limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- ONNX Runtime Web supports in-browser inference: https://onnxruntime.ai/docs/tutorials/web/

## What managers do
1) Open the site
2) Upload the **source Excel** (sheet `0_Source_Forecast`)
3) Upload the **ONNX model** (`.onnx`)
4) Choose **Rolling** (next 7 days) or **Scenario** (multi-week)
5) Click **Run forecast**
6) See projections + % error where actuals exist + **GOOD/OK/BAD** badge (Orders)

## Repo structure
- `index.html` – UI
- `app.js` – loads Excel, runs ONNX inference, renders results
- `feature_engineering.js` – transforms rows into the exact feature vector used by the model
- `kpi.js` – KPI calculations + Orders verdict gate
- `styles.css` – basic styling

## IMPORTANT: feature order must match the training pipeline
Open `feature_engineering.js` and edit `FEATURE_ORDER` to exactly match the feature order used when exporting the ONNX model.

Also verify model outputs mapping in `app.js`:
- If your ONNX model outputs a single tensor with `[predOrders, predSales]`, keep the current mapping.
- If it outputs 2 tensors, adjust to match `session.outputNames`.

## How to publish on GitHub Pages
1) Create a repo named `gr-forecast-tool`
2) Upload these files
3) In GitHub: **Settings → Pages → Build and deployment**
4) Choose **Deploy from a branch** → branch `main` → folder `/root`

## How to create the ONNX model (suggested approach)
This repo assumes you train offline (e.g., on your laptop) and publish `model.onnx`.
Common options:
- `skl2onnx` (for scikit-learn pipelines)
- `onnxmltools`

**Key requirement:** the exported model must accept a 2D float tensor `[1, num_features]` and output predictions for Orders (+ Sales if included).

## Scenario mode note
Scenario mode extends future dates if they’re not already in the Excel. It uses the **last known levers** as placeholders. For real scenario planning, add future rows in Excel with the promo plan (discounts, Free Shipping, KSM, Singles Day/BF flags).
