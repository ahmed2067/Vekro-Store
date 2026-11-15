require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);

function safkaConfig() {
  const base = (process.env.SAFKA_API_BASE_URL || "").trim().replace(/\/$/, "");
  const key = (process.env.SAFKA_API_KEY || "").trim();
  if (!base || !key) {
    const error = new Error("Safka connection is not configured on the server yet.");
    error.status = 503;
    throw error;
  }
  return { base, key };
}

function endpointPath(value, label) {
  const p = (value || "").trim();
  if (!p || !p.startsWith("/")) {
    const error = new Error(label + " endpoint path is not configured.");
    error.status = 503;
    throw error;
  }
  // Only allow paths under Safka's documented public API namespace.
  if (!p.startsWith("/api/v1/public/") && p !== "/api/v1/public") {
    const error = new Error(label + " endpoint must be under /api/v1/public.");
    error.status = 500;
    throw error;
  }
  return p;
}

async function safkaRequest(method, endpoint, body) {
  const { base, key } = safkaConfig();
  const url = new URL(endpoint, base);
  const response = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "api-safka-key": key
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { message: "Safka returned a non-JSON response." }; }
  if (!response.ok) {
    const error = new Error(data.message || data.error || "Safka request failed (" + response.status + ").");
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return data;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "VEKRO Store",
    safkaConfigured: Boolean(process.env.SAFKA_API_BASE_URL && process.env.SAFKA_API_KEY)
  });
});

app.get("/api/products", async (_req, res) => {
  try {
    const endpoint = endpointPath(process.env.SAFKA_PRODUCTS_PATH, "Products");
    const data = await safkaRequest("GET", endpoint);
    res.json(data);
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const endpoint = endpointPath(process.env.SAFKA_CREATE_ORDER_PATH, "Create order");
    const { customer, items } = req.body || {};
    if (!customer || !customer.name || !customer.phone || !customer.address || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Please provide customer name, phone, address, and at least one item." });
    }
    // The browser never receives the Safka key. Confirm the exact payload schema
    // against Safka's order-creation documentation before enabling live orders.
    const data = await safkaRequest("POST", endpoint, req.body);
    res.status(201).json({ ok: true, data });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log("VEKRO Store listening on port " + PORT));
