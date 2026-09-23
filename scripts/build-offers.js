#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "source", "offers.csv");
const OUT_DIR = path.join(ROOT, "data");

const CUELINKS_API_KEY = String(process.env.CUELINKS_API_KEY || "").trim();
const CUELINKS_API_BASE = String(
  process.env.CUELINKS_API_BASE || "https://developers.cuelinks.com/pub_api/v3"
).replace(/\/$/, "");

function fail(message) {
  console.error("[build-offers] " + message);
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) fail("Missing source/offers.csv");
if (!CUELINKS_API_KEY) fail("Missing CUELINKS_API_KEY environment variable");

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];

    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(v => v.replace(/^\uFEFF/, "").trim());

  return rows.slice(1)
    .filter(r => r.some(v => String(v ?? "").trim() !== ""))
    .map(r =>
      Object.fromEntries(
        headers.map((h, i) => [h, String(r[i] ?? "").trim()])
      )
    );
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
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function splitCategories(value) {
  return [
    ...new Set(
      String(value ?? "")
        .split(/[,;|]/)
        .map(s => s.trim())
        .filter(Boolean)
    )
  ];
}

function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function campaignIdFromRow(row) {
  const candidates = [
    row["Campaign ID"],
    row["campaign_id"],
    row["Cuelinks Campaign ID"],
    row["Cuelinks Campaign Id"]
  ];

  for (const value of candidates) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }

  return null;
}

function stableId(row, countryIso = "") {
  const raw = [
    "Id",
    "Campaign ID",
    "Merchant",
    "Title",
    "Coupon Code",
    "URL"
  ]
    .map(k => String(row[k] ?? "").trim())
    .concat(countryIso)
    .join("|");

  let h = 2166136261;

  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return "avd-" + (h >>> 0).toString(36);
}

function normalizeCountry(country) {
  if (!country || typeof country !== "object") return null;

  const id = clean(country.id);
  const iso = clean(country.iso)?.toUpperCase() || null;
  const name = clean(country.name);

  if (!iso && !name) return null;

  return {
    id: id || null,
    iso: iso || null,
    name: name || iso || "Unknown",
    slug: slug(name || iso || "unknown")
  };
}

async function fetchCuelinksJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: "Token " + CUELINKS_API_KEY,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      "Cuelinks returned non-JSON from " +
      url +
      " (HTTP " +
      response.status +
      ")"
    );
  }

  if (!response.ok) {
    throw new Error(
      "Cuelinks API failed with HTTP " +
      response.status +
      ": " +
      JSON.stringify(body)
    );
  }

  return body;
}

async function fetchOpenCampaigns() {
  const campaigns = [];
  let page = 1;
  let expectedTotal = null;

  while (true) {
    const url = new URL(CUELINKS_API_BASE + "/campaigns");
    url.searchParams.set("access_status", "open");
    url.searchParams.set("per_page", "500");
    url.searchParams.set("page", String(page));

    const body = await fetchCuelinksJson(url);
    const data = Array.isArray(body.data) ? body.data : [];

    if (page === 1) {
      expectedTotal = Number(body.meta?.total ?? 0);
    }

    campaigns.push(...data);

    const nextPage = body.meta?.next_page;

    if (!nextPage || data.length === 0) break;

    page = Number(nextPage);

    if (!Number.isFinite(page)) {
      throw new Error("Cuelinks returned an invalid next_page value");
    }
  }

  if (campaigns.length === 0) {
    throw new Error(
      "Cuelinks returned zero open campaigns. Refusing to publish an unvalidated catalog."
    );
  }

  return {
    campaigns,
    expectedTotal: Number.isFinite(expectedTotal) ? expectedTotal : campaigns.length
  };
}

function getCampaignCountries(campaign) {
  const raw = Array.isArray(campaign?.countries) ? campaign.countries : [];
  return raw.map(normalizeCountry).filter(Boolean);
}

function normalize(row, today, campaign, country) {
  const status = String(row["Status"] ?? "").trim().toLowerCase();
  const startDate = parseDate(row["Start Date"]);
  const endDate = parseDate(row["End Date"]);

  if (status && status !== "live") return null;
  if (startDate && startDate > today) return null;
  if (endDate && endDate < today) return null;

  const categories = splitCategories(row["Categories"]);
  const merchant =
    clean(row["Merchant"]) ||
    clean(row["Campaign Name"]) ||
    clean(campaign?.name) ||
    "Unknown Merchant";

  const couponCode = clean(row["Coupon Code"]);
  const campaignId = campaignIdFromRow(row);

  return {
    id: stableId(row, country.iso || country.name),
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
    affiliateUrl: clean(row["URL"]) || clean(campaign?.tracking_url),
    imageUrl: clean(row["Image URL"]) || clean(campaign?.image),
    startDate,
    endDate,
    offerAddedAt: clean(row["Offer Added At"]),
    campaignId,
    campaignName: clean(row["Campaign Name"]) || clean(campaign?.name),

    // Cuelinks is the source of truth for campaign availability and geography.
    cuelinksCampaignId: campaign?.id ?? null,
    cuelinksCampaignName: clean(campaign?.name),
    cuelinksAccessStatus: clean(campaign?.access_status),
    cuelinksTrackingUrl: clean(campaign?.tracking_url),

    countryId: country.id,
    countryIso: country.iso,
    countryName: country.name,
    countrySlug: country.slug
  };
}

function dedupe(items) {
  const map = new Map();

  for (const item of items) {
    const key = [
      item.countryIso || "",
      item.merchantSlug,
      item.campaignId || "",
      item.couponCode || "",
      item.title.toLowerCase(),
      item.affiliateUrl || ""
    ].join("|");

    const old = map.get(key);

    if (!old || (item.endDate || "") > (old.endDate || "")) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

function buildMerchantAndCategoryIndexes(offers) {
  const merchantMap = new Map();
  const categoryMap = new Map();

  for (const offer of offers) {
    if (!merchantMap.has(offer.merchantSlug)) {
      merchantMap.set(offer.merchantSlug, {
        id: offer.merchantSlug,
        name: offer.merchant,
        logoUrl: offer.imageUrl,
        offerCount: 0,
        couponCount: 0,
        dealCount: 0
      });
    }

    const merchant = merchantMap.get(offer.merchantSlug);
    merchant.offerCount++;

    if (offer.type === "coupon") {
      merchant.couponCount++;
    } else {
      merchant.dealCount++;
    }

    if (!merchant.logoUrl && offer.imageUrl) {
      merchant.logoUrl = offer.imageUrl;
    }

    for (const category of offer.categories) {
      const id = slug(category);
      if (!id) continue;

      if (!categoryMap.has(id)) {
        categoryMap.set(id, {
          id,
          name: category,
          offerCount: 0,
          couponCount: 0,
          dealCount: 0
        });
      }

      const item = categoryMap.get(id);
      item.offerCount++;

      if (offer.type === "coupon") {
        item.couponCount++;
      } else {
        item.dealCount++;
      }
    }
  }

  return {
    merchants: [...merchantMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    categories: [...categoryMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  };
}

function writeJson(file, value) {
  fs.writeFileSync(
    path.join(OUT_DIR, file),
    JSON.stringify(value, null, 2) + "\n",
    "utf8"
  );
}

function buildCountryStats(offers) {
  const map = new Map();

  for (const offer of offers) {
    const key = offer.countryIso || offer.countrySlug || "unknown";

    if (!map.has(key)) {
      map.set(key, {
        id: offer.countryId,
        iso: offer.countryIso,
        name: offer.countryName,
        slug: offer.countrySlug,
        offerCount: 0,
        couponCount: 0,
        dealCount: 0
      });
    }

    const country = map.get(key);
    country.offerCount++;

    if (offer.type === "coupon") {
      country.couponCount++;
    } else {
      country.dealCount++;
    }
  }

  return [...map.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );
}

async function main() {
  const today = todayIndia();
  const rows = parseCsv(fs.readFileSync(SOURCE, "utf8"));

  console.log(
    JSON.stringify(
      {
        step: "cuelinks_validation_start",
        sourceRows: rows.length,
        effectiveDate: today
      },
      null,
      2
    )
  );

  const {
    campaigns,
    expectedTotal
  } = await fetchOpenCampaigns();

  const campaignMap = new Map();

  for (const campaign of campaigns) {
    const id = clean(campaign?.id);
    if (!id) continue;

    if (String(campaign.access_status || "").toLowerCase() !== "open") {
      continue;
    }

    campaignMap.set(id, campaign);
  }

  let rowsWithoutCampaignId = 0;
  let rowsWithInactiveCampaign = 0;
  let rowsWithoutCountry = 0;
  let rowsRejectedByDateOrStatus = 0;
  let matchedRows = 0;

  const expanded = [];

  for (const row of rows) {
    const campaignId = campaignIdFromRow(row);

    if (!campaignId) {
      rowsWithoutCampaignId++;
      continue;
    }

    const campaign = campaignMap.get(campaignId);

    if (!campaign) {
      rowsWithInactiveCampaign++;
      continue;
    }

    const countries = getCampaignCountries(campaign);

    if (countries.length === 0) {
      rowsWithoutCountry++;
      continue;
    }

    let rowProducedOffer = false;

    for (const country of countries) {
      const offer = normalize(row, today, campaign, country);

      if (!offer) continue;

      expanded.push(offer);
      rowProducedOffer = true;
    }

    if (rowProducedOffer) {
      matchedRows++;
    } else {
      rowsRejectedByDateOrStatus++;
    }
  }

  const offers = dedupe(expanded).sort((a, b) =>
    (a.countryName || "").localeCompare(b.countryName || "") ||
    a.merchant.localeCompare(b.merchant) ||
    a.title.localeCompare(b.title)
  );

  const coupons = offers.filter(o => o.type === "coupon");
  const deals = offers.filter(o => o.type === "deal");
  const {
    merchants,
    categories
  } = buildMerchantAndCategoryIndexes(offers);
  const countries = buildCountryStats(offers);
  const generatedAt = new Date().toISOString();

  if (offers.length === 0) {
    throw new Error(
      "No offers survived Cuelinks campaign validation and country filtering. Refusing to publish an empty catalog."
    );
  }

  // Single unified feed. Each offer carries countryIso/countryName/countrySlug,
  // so the app can filter this same file according to the user's selected region.
  writeJson("offers.json", {
    version: 2,
    generatedAt,
    effectiveDate: today,
    total: offers.length,
    coupons: coupons.length,
    deals: deals.length,
    countries,
    offers
  });

  // Keep the existing derived feeds for current consumers. They contain the
  // same validated offers and retain the country fields.
  writeJson("coupons.json", {
    version: 2,
    generatedAt,
    effectiveDate: today,
    total: coupons.length,
    countries,
    offers: coupons
  });

  writeJson("deals.json", {
    version: 2,
    generatedAt,
    effectiveDate: today,
    total: deals.length,
    countries,
    offers: deals
  });

  writeJson("merchants.json", {
    version: 2,
    generatedAt,
    effectiveDate: today,
    total: merchants.length,
    merchants
  });

  writeJson("categories.json", {
    version: 2,
    generatedAt,
    effectiveDate: today,
    total: categories.length,
    categories
  });

  writeJson("offers-manifest.json", {
    version: 2,
    generatedAt,
    effectiveDate: today,
    source: "source/offers.csv",
    sourceRows: rows.length,

    cuelinks: {
      apiBase: CUELINKS_API_BASE,
      accessStatus: "open",
      campaignsReturned: campaigns.length,
      campaignsReportedTotal: expectedTotal
    },

    validation: {
      matchedRows,
      rowsWithoutCampaignId,
      rowsWithInactiveCampaign,
      rowsWithoutCountry,
      rowsRejectedByDateOrStatus,
      expandedOffersBeforeDedupe: expanded.length,
      activeOffersAfterDedupe: offers.length
    },

    activeOffers: offers.length,
    coupons: coupons.length,
    deals: deals.length,
    merchants: merchants.length,
    categories: categories.length,
    countries: countries.length,

    countryBreakdown: countries,

    files: {
      offers: "offers.json",
      coupons: "coupons.json",
      deals: "deals.json",
      merchants: "merchants.json",
      categories: "categories.json"
    }
  });

  console.log(
    JSON.stringify(
      {
        effectiveDate: today,
        sourceRows: rows.length,
        cuelinksOpenCampaigns: campaigns.length,
        matchedRows,
        dropped: {
          rowsWithoutCampaignId,
          rowsWithInactiveCampaign,
          rowsWithoutCountry,
          rowsRejectedByDateOrStatus
        },
        activeOffers: offers.length,
        coupons: coupons.length,
        deals: deals.length,
        merchants: merchants.length,
        categories: categories.length,
        countries: countries.map(c => ({
          iso: c.iso,
          name: c.name,
          offers: c.offerCount,
          coupons: c.couponCount,
          deals: c.dealCount
        }))
      },
      null,
      2
    )
  );
}

main().catch(error => fail(error?.message || String(error)));
