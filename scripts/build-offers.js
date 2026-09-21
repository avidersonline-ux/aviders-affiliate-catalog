#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "source", "offers.csv");
const OUT_DIR = path.join(ROOT, "data");

function fail(message) {
  console.error("[build-offers] " + message);
  process.exit(1);
}
if (!fs.existsSync(SOURCE)) fail("Missing source/offers.csv");

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(v => v.replace(/^\uFEFF/, "").trim());
  return rows.slice(1)
    .filter(r => r.some(v => String(v ?? "").trim() !== ""))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? "").trim()])));
}

function clean(value) {
  const v = String(value ?? "").trim();
  return v || null;
}

function parseDate(value) {
  const v = clean(value);
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function todayIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function splitCategories(value) {
  return [...new Set(String(value ?? "").split(/[,;|]/).map(s => s.trim()).filter(Boolean))];
}

function slug(value) {
  return String(value ?? "").toLowerCase().trim()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function stableId(row) {
  const raw = ["Id","Campaign ID","Merchant","Title","Coupon Code","URL"]
    .map(k => String(row[k] ?? "").trim()).join("|");
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "avd-" + (h >>> 0).toString(36);
}

function normalize(row, today) {
  const status = String(row["Status"] ?? "").trim().toLowerCase();
  const startDate = parseDate(row["Start Date"]);
  const endDate = parseDate(row["End Date"]);
  if (status && status !== "live") return null;
  if (startDate && startDate > today) return null;
  if (endDate && endDate < today) return null;

  const categories = splitCategories(row["Categories"]);
  const merchant = clean(row["Merchant"]) || clean(row["Campaign Name"]) || "Unknown Merchant";
  const couponCode = clean(row["Coupon Code"]);

  return {
    id: stableId(row),
    sourceId: clean(row["Id"]),
    title: clean(row["Title"]) || "Offer",
    merchant,
    merchantSlug: slug(merchant),
    categories,
    categorySlugs: categories.map(slug),
    description: clean(row["Description"]),
    terms: clean(row["Terms"]),
    couponCode,
    type: couponCode ? "coupon" : "deal",
    affiliateUrl: clean(row["URL"]),
    imageUrl: clean(row["Image URL"]),
    startDate,
    endDate,
    offerAddedAt: clean(row["Offer Added At"]),
    campaignId: clean(row["Campaign ID"]),
    campaignName: clean(row["Campaign Name"])
  };
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const key = [
      item.merchantSlug, item.campaignId || "", item.couponCode || "",
      item.title.toLowerCase(), item.affiliateUrl || ""
    ].join("|");
    const old = map.get(key);
    if (!old || (item.endDate || "") > (old.endDate || "")) map.set(key, item);
  }
  return [...map.values()];
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(value, null, 2) + "\n", "utf8");
}

const today = todayIndia();
const rows = parseCsv(fs.readFileSync(SOURCE, "utf8"));
const offers = dedupe(rows.map(r => normalize(r, today)).filter(Boolean))
  .sort((a, b) => a.merchant.localeCompare(b.merchant) || a.title.localeCompare(b.title));
const coupons = offers.filter(o => o.type === "coupon");
const deals = offers.filter(o => o.type === "deal");

const merchantMap = new Map();
const categoryMap = new Map();

for (const o of offers) {
  if (!merchantMap.has(o.merchantSlug)) merchantMap.set(o.merchantSlug, {
    id: o.merchantSlug, name: o.merchant, logoUrl: o.imageUrl,
    offerCount: 0, couponCount: 0, dealCount: 0
  });
  const m = merchantMap.get(o.merchantSlug);
  m.offerCount++;
  if (o.type === "coupon") m.couponCount++; else m.dealCount++;
  if (!m.logoUrl && o.imageUrl) m.logoUrl = o.imageUrl;

  for (const cat of o.categories) {
    const id = slug(cat);
    if (!id) continue;
    if (!categoryMap.has(id)) categoryMap.set(id, {
      id, name: cat, offerCount: 0, couponCount: 0, dealCount: 0
    });
    const c = categoryMap.get(id);
    c.offerCount++;
    if (o.type === "coupon") c.couponCount++; else c.dealCount++;
  }
}

const merchants = [...merchantMap.values()].sort((a,b) => a.name.localeCompare(b.name));
const categories = [...categoryMap.values()].sort((a,b) => a.name.localeCompare(b.name));
const generatedAt = new Date().toISOString();

writeJson("offers.json", {version:1, generatedAt, effectiveDate:today, total:offers.length, coupons:coupons.length, deals:deals.length, offers});
writeJson("coupons.json", {version:1, generatedAt, effectiveDate:today, total:coupons.length, offers:coupons});
writeJson("deals.json", {version:1, generatedAt, effectiveDate:today, total:deals.length, offers:deals});
writeJson("merchants.json", {version:1, generatedAt, effectiveDate:today, total:merchants.length, merchants});
writeJson("categories.json", {version:1, generatedAt, effectiveDate:today, total:categories.length, categories});
writeJson("offers-manifest.json", {
  version:1, generatedAt, effectiveDate:today, source:"source/offers.csv",
  sourceRows:rows.length, activeOffers:offers.length, coupons:coupons.length,
  deals:deals.length, merchants:merchants.length, categories:categories.length,
  files:{offers:"offers.json", coupons:"coupons.json", deals:"deals.json", merchants:"merchants.json", categories:"categories.json"}
});

console.log(JSON.stringify({
  effectiveDate:today, sourceRows:rows.length, activeOffers:offers.length,
  coupons:coupons.length, deals:deals.length, merchants:merchants.length, categories:categories.length
}, null, 2));
