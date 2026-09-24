#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "source", "offers.csv");
const OUT_DIR = path.join(ROOT, "data");
const COUNTRY_CONFIG = path.join(ROOT, "config", "countries.json");

const CUELINKS_API_KEY = String(process.env.CUELINKS_API_KEY || "").trim();
const CUELINKS_API_BASE = String(
  process.env.CUELINKS_API_BASE || "https://developers.cuelinks.com/pub_api/v3"
).replace(/\/$/, "");

function fail(message) {
  console.error("[build-offers] " + message);
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) fail("Missing source/offers.csv");
if (!fs.existsSync(COUNTRY_CONFIG)) fail("Missing config/countries.json");
if (!CUELINKS_API_KEY) fail("Missing CUELINKS_API_KEY environment variable");

function loadAllowedCountries() {
  const raw = JSON.parse(fs.readFileSync(COUNTRY_CONFIG, "utf8"));
  const countries = Array.isArray(raw) ? raw : raw.countries;
  if (!Array.isArray(countries) || countries.length === 0) {
    fail("config/countries.json must contain a non-empty countries array");
  }

  const aliases = { UK: "GB" };
  return new Set(
    countries
      .map(value => String(value || "").trim().toUpperCase())
      .map(value => aliases[value] || value)
      .filter(Boolean)
  );
}

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

function firstValue(object, keys) {
  for (const key of keys) {
    const value = clean(object?.[key]);
    if (value) return value;
  }
  return null;
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

function categoriesFromValue(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap(item => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object") {
          return [item.name, item.title, item.label].filter(Boolean);
        }
        return [];
      })
      .map(clean)
      .filter(Boolean);
  }

  return splitCategories(value);
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

const PARTNER_COLUMNS = [
  "AF-partner",
  "AF Partner",
  "AF affiliate",
  "AF Affiliate",
  "Affiliate Partner",
  "affiliate_partner",
  "af_partner"
];

function partnerFromRow(row, hasPartnerColumn) {
  const explicitPartner = firstValue(row, PARTNER_COLUMNS);
  if (explicitPartner) return explicitPartner;

  // Blank partner values remain Cuelinks for backward compatibility.
  // This preserves the existing ~2K Cuelinks rows without requiring CSV edits.
  return "Cuelinks";
}

function isCuelinksPartner(value) {
  return String(value || "").trim().toLowerCase() === "cuelinks";
}

function stableId(row, countryIso = "", source = "csv", extra = "") {
  const raw = [
    source,
    "Id",
    "Campaign ID",
    "Merchant",
    "Title",
    "Coupon Code",
    "URL",
    extra
  ]
    .map(k => String(row[k] ?? k ?? "").trim())
    .concat(countryIso)
    .join("|");

  let h = 2166136261;

  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return "avd-" + (h >>> 0).toString(36);
}

function stableApiId(offer, countryIso = "") {
  return stableId(
    {
      Id: offer?.id,
      "Campaign ID": offer?.campaign_id,
      Merchant: offer?.campaign_name,
      Title: offer?.title || offer?.name,
      "Coupon Code": offer?.coupon_code || offer?.code,
      URL: offer?.tracking_url || offer?.url
    },
    countryIso,
    "cuelinks-api",
    String(offer?.id ?? "")
  );
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

function countryFromRow(row) {
  const iso = firstValue(row, [
    "Country ISO",
    "Country Iso",
    "country_iso",
    "Country Code",
    "countryCode"
  ]);

  const name = firstValue(row, [
    "Country",
    "country",
    "Country Name",
    "country_name"
  ]);

  if (!iso && !name) return null;

  return normalizeCountry({
    iso: iso || null,
    name: name || iso
  });
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
      throw new Error("Cuelinks returned an invalid campaigns next_page value");
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

async function fetchLiveCuelinksOffers() {
  const offers = [];
  let page = 1;
  let expectedTotal = null;

  while (true) {
    const url = new URL(CUELINKS_API_BASE + "/offers");
    url.searchParams.set("per_page", "500");
    url.searchParams.set("page", String(page));
    url.searchParams.set("valid_on", todayIndia());

    const body = await fetchCuelinksJson(url);
    const data = Array.isArray(body.data) ? body.data : [];

    if (page === 1) {
      expectedTotal = Number(body.meta?.total ?? 0);
    }

    offers.push(...data);

    const nextPage = body.meta?.next_page;
    if (!nextPage || data.length === 0) break;

    page = Number(nextPage);
    if (!Number.isFinite(page)) {
      throw new Error("Cuelinks returned an invalid offers next_page value");
    }
  }

  return {
    offers,
    expectedTotal: Number.isFinite(expectedTotal) ? expectedTotal : offers.length
  };
}

function getCampaignCountries(campaign) {
  const raw = Array.isArray(campaign?.countries) ? campaign.countries : [];
  return raw.map(normalizeCountry).filter(Boolean);
}

function normalizeCommon({
  sourceId,
  title,
  merchant,
  categories,
  description,
  terms,
  couponCode,
  affiliateUrl,
  imageUrl,
  startDate,
  endDate,
  offerAddedAt,
  campaignId,
  campaignName,
  partner,
  source,
  country,
  campaign
}) {
  return {
    id: source === "cuelinks-api"
      ? stableApiId({ id: sourceId, campaign_id: campaignId, campaign_name: campaignName, title, coupon_code: couponCode, tracking_url: affiliateUrl }, country?.iso || "")
      : stableId(
          {
            Id: sourceId,
            "Campaign ID": campaignId,
            Merchant: merchant,
            Title: title,
            "Coupon Code": couponCode,
            URL: affiliateUrl
          },
          country?.iso || "",
          "csv"
        ),
    sourceId: sourceId || null,
    source,
    afPartner: partner,
    title: title || "Offer",
    merchant: merchant || "Unknown Merchant",
    merchantSlug: slug(merchant || "unknown-merchant"),
    categories: [...new Set(categories.filter(Boolean))],
    categorySlugs: [...new Set(categories.filter(Boolean).map(slug).filter(Boolean))],
    description: description || null,
    terms: terms || null,
    couponCode: couponCode || null,
    type: couponCode ? "coupon" : "deal",
    affiliateUrl: affiliateUrl || null,
    imageUrl: imageUrl || null,
    startDate: startDate || null,
    endDate: endDate || null,
    offerAddedAt: offerAddedAt || null,
    campaignId: campaignId || null,
    campaignName: campaignName || null,
    cuelinksCampaignId: campaign?.id ?? null,
    cuelinksCampaignName: clean(campaign?.name),
    cuelinksAccessStatus: clean(campaign?.access_status),
    cuelinksTrackingUrl: clean(campaign?.tracking_url),
    countryId: country?.id || null,
    countryIso: country?.iso || null,
    countryName: country?.name || null,
    countrySlug: country?.slug || null
  };
}

function normalizeCsvRow(row, today, campaign, country, partner) {
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

  return normalizeCommon({
    sourceId: clean(row["Id"]),
    title: clean(row["Title"]),
    merchant,
    categories,
    description: clean(row["Description"]),
    terms: clean(row["Terms"]),
    couponCode,
    affiliateUrl: clean(row["URL"]) || clean(campaign?.tracking_url),
    imageUrl: clean(row["Image URL"]) || clean(campaign?.image),
    startDate,
    endDate,
    offerAddedAt: clean(row["Offer Added At"]),
    campaignId,
    campaignName: clean(row["Campaign Name"]) || clean(campaign?.name),
    partner,
    source: "csv",
    country,
    campaign
  });
}

function normalizeCuelinksApiOffer(offer, today, campaign, country) {
  const offerType = String(
    firstValue(offer, ["offer_type", "type"]) || ""
  ).toLowerCase();

  const title =
    firstValue(offer, ["title", "name"]) ||
    firstValue(offer, ["description"]) ||
    "Offer";

  const merchant =
    firstValue(offer, ["merchant", "merchant_name", "campaign_name"]) ||
    clean(campaign?.name) ||
    "Unknown Merchant";

  const categories = categoriesFromValue(
    offer?.categories ?? offer?.category ?? offer?.category_name
  );

  const couponCode = firstValue(offer, [
    "coupon_code",
    "code",
    "voucher_code"
  ]);

  const startDate = parseDate(
    firstValue(offer, ["start_date", "valid_from", "starts_at"])
  );

  const endDate = parseDate(
    firstValue(offer, ["end_date", "valid_until", "expires_at"])
  );

  if (startDate && startDate > today) return null;
  if (endDate && endDate < today) return null;

  const affiliateUrl =
    firstValue(offer, ["tracking_url", "affiliate_url", "url"]) ||
    clean(campaign?.tracking_url);

  const type = offerType === "coupon" || couponCode ? "coupon" : "deal";

  const normalized = normalizeCommon({
    sourceId: clean(offer?.id),
    title,
    merchant,
    categories,
    description: firstValue(offer, ["description"]),
    terms: firstValue(offer, ["terms", "terms_and_condition"]),
    couponCode: type === "coupon" ? couponCode : null,
    affiliateUrl,
    imageUrl: firstValue(offer, ["image", "image_url"]) || clean(campaign?.image),
    startDate,
    endDate,
    offerAddedAt: firstValue(offer, ["created_at", "updated_at"]),
    campaignId: clean(offer?.campaign_id),
    campaignName: clean(offer?.campaign_name) || clean(campaign?.name),
    partner: "Cuelinks",
    source: "cuelinks-api",
    country,
    campaign
  });

  normalized.cuelinksOfferId = clean(offer?.id);
  normalized.cuelinksOfferType = offerType || normalized.type;
  return normalized;
}

function dedupe(items) {
  const map = new Map();

  for (const item of items) {
    const key = [
      item.countryIso || "",
      item.afPartner || "",
      item.merchantSlug,
      item.campaignId || "",
      item.couponCode || "",
      item.title.toLowerCase(),
      item.affiliateUrl || ""
    ].join("|");

    const old = map.get(key);

    if (
      !old ||
      (item.endDate || "") > (old.endDate || "") ||
      (item.source === "cuelinks-api" && old.source !== "cuelinks-api")
    ) {
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

    if (offer.type === "coupon") merchant.couponCount++;
    else merchant.dealCount++;

    if (!merchant.logoUrl && offer.imageUrl) merchant.logoUrl = offer.imageUrl;

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

      if (offer.type === "coupon") item.couponCount++;
      else item.dealCount++;
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

function writeChunkedCatalog(kind, items, generatedAt, effectiveDate) {
  const baseDir = path.join(OUT_DIR, "catalog", kind);
  fs.rmSync(baseDir, { recursive: true, force: true });

  const grouped = new Map();

  for (const item of items) {
    const countryKey = slug(item.countryIso || item.countrySlug || "unknown") || "unknown";
    if (!grouped.has(countryKey)) grouped.set(countryKey, []);
    grouped.get(countryKey).push(item);
  }

  const indexCountries = [];

  for (const [countryKey, countryItems] of grouped.entries()) {
    const countryDir = path.join(baseDir, countryKey);
    fs.mkdirSync(countryDir, { recursive: true });

    const chunks = [];
    let current = [];

    const makePayload = values => ({
      version: 4,
      generatedAt,
      effectiveDate,
      kind,
      country: countryKey,
      total: values.length,
      offers: values
    });

    for (const item of countryItems) {
      const candidate = [...current, item];
      const candidateBytes = Buffer.byteLength(
        JSON.stringify(makePayload(candidate)),
        "utf8"
      );

      if (candidateBytes > 8 * 1024 * 1024 && current.length > 0) {
        chunks.push(current);
        current = [item];
      } else {
        current = candidate;
      }

      if (
        Buffer.byteLength(JSON.stringify(makePayload(current)), "utf8") >
        8 * 1024 * 1024
      ) {
        throw new Error(
          "Single catalog offer exceeds the 8 MB chunk safety limit: " +
          String(item.id || item.title || "unknown")
        );
      }
    }

    if (current.length) chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      const filename = `${countryKey}-${String(i + 1).padStart(3, "0")}.json`;
      fs.writeFileSync(
        path.join(countryDir, filename),
        JSON.stringify(makePayload(chunks[i])) + "\n",
        "utf8"
      );
    }

    const first = countryItems[0] || {};
    indexCountries.push({
      iso: first.countryIso || null,
      id: first.countryId || null,
      name: first.countryName || countryKey,
      slug: first.countrySlug || countryKey,
      offerCount: countryItems.length,
      couponCount: countryItems.filter(o => o.type === "coupon").length,
      dealCount: countryItems.filter(o => o.type === "deal").length,
      chunks: chunks.map((_, i) =>
        `data/catalog/${kind}/${countryKey}/${countryKey}-${String(i + 1).padStart(3, "0")}.json`
      )
    });
  }

  return indexCountries.sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );
}

function writeCatalogIndex(file, kind, items, generatedAt, effectiveDate, countries) {
  writeJson(file, {
    version: 4,
    generatedAt,
    effectiveDate,
    kind,
    total: items.length,
    coupons: items.filter(o => o.type === "coupon").length,
    deals: items.filter(o => o.type === "deal").length,
    countries,
    chunks: countries.flatMap(country => country.chunks)
  });
}

function writeJson(file, value) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
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
        name: offer.countryName || "Unknown",
        slug: offer.countrySlug || "unknown",
        offerCount: 0,
        couponCount: 0,
        dealCount: 0
      });
    }

    const country = map.get(key);
    country.offerCount++;

    if (offer.type === "coupon") country.couponCount++;
    else country.dealCount++;
  }

  return [...map.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );
}

async function main() {
  const today = todayIndia();
  const rows = parseCsv(fs.readFileSync(SOURCE, "utf8"));
  const allowedCountries = loadAllowedCountries();
  const csvHasPartnerColumn = rows.some(row =>
    PARTNER_COLUMNS.some(key => Object.prototype.hasOwnProperty.call(row, key))
  );

  console.log(
    JSON.stringify(
      {
        step: "cuelinks_and_multi_partner_build_start",
        sourceRows: rows.length,
        effectiveDate: today,
        allowedCountries: [...allowedCountries]
      },
      null,
      2
    )
  );

  const { campaigns, expectedTotal: campaignsReportedTotal } =
    await fetchOpenCampaigns();

  const { offers: cuelinksApiOffers, expectedTotal: offersReportedTotal } =
    await fetchLiveCuelinksOffers();

  const campaignMap = new Map();

  for (const campaign of campaigns) {
    const id = clean(campaign?.id);
    if (!id) continue;

    if (String(campaign.access_status || "").toLowerCase() !== "open") {
      continue;
    }

    campaignMap.set(id, campaign);
  }

  let csvCuelinksRows = 0;
  let csvNonCuelinksRows = 0;
  let csvRowsWithoutPartner = 0;
  let csvCuelinksWithoutCampaignId = 0;
  let csvCuelinksInactiveCampaign = 0;
  let csvCuelinksWithoutCountry = 0;
  let csvCuelinksRejectedByDateOrStatus = 0;
  let csvNonCuelinksRejectedByDateOrStatus = 0;
  let csvOffersPublished = 0;
  let apiOffersPublished = 0;
  let apiOffersWithoutCampaign = 0;
  let apiOffersWithoutCountry = 0;
  let apiOffersRejectedByDate = 0;

  const expanded = [];

  for (const row of rows) {
    const partner = partnerFromRow(row, csvHasPartnerColumn);

    if (!firstValue(row, PARTNER_COLUMNS)) {
      csvRowsWithoutPartner++;
    }

    if (isCuelinksPartner(partner)) {
      csvCuelinksRows++;

      const campaignId = campaignIdFromRow(row);

      if (!campaignId) {
        csvCuelinksWithoutCampaignId++;
        continue;
      }

      const campaign = campaignMap.get(campaignId);

      if (!campaign) {
        csvCuelinksInactiveCampaign++;
        continue;
      }

      const countries = getCampaignCountries(campaign);

      if (countries.length === 0) {
        csvCuelinksWithoutCountry++;
        continue;
      }

      let produced = false;

      for (const country of countries) {
        if (!allowedCountries.has(String(country.iso || "").toUpperCase())) continue;

        const offer = normalizeCsvRow(row, today, campaign, country, partner);
        if (!offer) continue;

        expanded.push(offer);
        produced = true;
        csvOffersPublished++;
      }

      if (!produced) csvCuelinksRejectedByDateOrStatus++;
      continue;
    }

    csvNonCuelinksRows++;

    const country = countryFromRow(row);

    if (!country || !allowedCountries.has(String(country.iso || "").toUpperCase())) {
      continue;
    }

    const offer = normalizeCsvRow(row, today, null, country, partner);

    if (offer) {
      expanded.push(offer);
      csvOffersPublished++;
    } else {
      csvNonCuelinksRejectedByDateOrStatus++;
    }
  }

  for (const apiOffer of cuelinksApiOffers) {
    const campaignId = clean(apiOffer?.campaign_id);

    if (!campaignId) {
      apiOffersWithoutCampaign++;
      continue;
    }

    const campaign = campaignMap.get(campaignId);

    if (!campaign) {
      apiOffersWithoutCampaign++;
      continue;
    }

    const countries = getCampaignCountries(campaign);

    if (countries.length === 0) {
      apiOffersWithoutCountry++;
      continue;
    }

    let produced = false;

    for (const country of countries) {
      if (!allowedCountries.has(String(country.iso || "").toUpperCase())) continue;

      const offer = normalizeCuelinksApiOffer(
        apiOffer,
        today,
        campaign,
        country
      );

      if (!offer) continue;

      expanded.push(offer);
      produced = true;
      apiOffersPublished++;
    }

    if (!produced) apiOffersRejectedByDate++;
  }

  const offers = dedupe(expanded).sort((a, b) =>
    (a.countryName || "").localeCompare(b.countryName || "") ||
    a.merchant.localeCompare(b.merchant) ||
    a.title.localeCompare(b.title)
  );

  const coupons = offers.filter(o => o.type === "coupon");
  const deals = offers.filter(o => o.type === "deal");
  const { merchants, categories } = buildMerchantAndCategoryIndexes(offers);
  const countries = buildCountryStats(offers);
  const generatedAt = new Date().toISOString();

  if (offers.length === 0) {
    throw new Error(
      "No offers survived validation. Refusing to publish an empty catalog."
    );
  }

  // Generated catalogs are chunked because GitHub blocks individual files over 100 MiB.
  // Chunks are country-scoped so the app only downloads the selected region.
  fs.rmSync(path.join(OUT_DIR, "catalog"), { recursive: true, force: true });

  const offerChunks = writeChunkedCatalog("offers", offers, generatedAt, today);
  const couponChunks = writeChunkedCatalog("coupons", coupons, generatedAt, today);
  const dealChunks = writeChunkedCatalog("deals", deals, generatedAt, today);

  writeCatalogIndex("offers.json", "offers", offers, generatedAt, today, offerChunks);
  writeCatalogIndex("coupons.json", "coupons", coupons, generatedAt, today, couponChunks);
  writeCatalogIndex("deals.json", "deals", deals, generatedAt, today, dealChunks);

  writeJson("merchants.json", {
    version: 3,
    generatedAt,
    effectiveDate: today,
    total: merchants.length,
    merchants
  });

  writeJson("categories.json", {
    version: 3,
    generatedAt,
    effectiveDate: today,
    total: categories.length,
    categories
  });

  writeJson("offers-manifest.json", {
    version: 3,
    generatedAt,
    effectiveDate: today,
    source: "source/offers.csv + Cuelinks /offers",
    sourceRows: rows.length,

    partners: {
      csvCuelinksRows,
      csvNonCuelinksRows,
      csvRowsWithoutPartner
    },

    cuelinks: {
      apiBase: CUELINKS_API_BASE,
      accessStatus: "open",
      campaignsReturned: campaigns.length,
      campaignsReportedTotal,
      liveOffersReturned: cuelinksApiOffers.length,
      liveOffersReportedTotal: offersReportedTotal
    },

    validation: {
      csvCuelinksWithoutCampaignId,
      csvCuelinksInactiveCampaign,
      csvCuelinksWithoutCountry,
      csvCuelinksRejectedByDateOrStatus,
      csvNonCuelinksRejectedByDateOrStatus,
      apiOffersWithoutCampaign,
      apiOffersWithoutCountry,
      apiOffersRejectedByDate,
      csvOffersPublished,
      apiOffersPublished,
      expandedOffersBeforeDedupe: expanded.length,
      activeOffersAfterDedupe: offers.length
    },

    activeOffers: offers.length,
    coupons: coupons.length,
    deals: deals.length,
    merchants: merchants.length,
    categories: categories.length,
    countries: countries.length,
    allowedCountries: [...allowedCountries],
    countryBreakdown: countries,

    files: {
      offers: "offers.json",
      coupons: "coupons.json",
      deals: "deals.json",
      merchants: "merchants.json",
      categories: "categories.json",
      catalogDirectory: "catalog/"
    },
    chunking: {
      maxChunkBytes: 8 * 1024 * 1024,
      countryScoped: true,
      appLoadsSelectedRegionOnly: true
    }
  });

  console.log(
    JSON.stringify(
      {
        effectiveDate: today,
        sourceRows: rows.length,
        cuelinksOpenCampaigns: campaigns.length,
        cuelinksLiveOffers: cuelinksApiOffers.length,
        csv: {
          cuelinksRows: csvCuelinksRows,
          nonCuelinksRows: csvNonCuelinksRows,
          offersPublished: csvOffersPublished
        },
        api: {
          offersPublished: apiOffersPublished,
          withoutCampaign: apiOffersWithoutCampaign,
          withoutCountry: apiOffersWithoutCountry,
          rejectedByDate: apiOffersRejectedByDate
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
