# Aviders Coupons & Offers Catalog

The catalog has two intake sources:

- `source/offers.csv`: the human-controlled master intake file for Cuelinks and other affiliate partners.
- Cuelinks V3 `/offers`: live Cuelinks coupons and deals discovered automatically during each build.

The CSV is never replaced by the Cuelinks API. This allows Aviders to add offers from future partners such as EarnKaro or direct/manual sources.

## Affiliate partner routing

Use the `AF-partner` column in the CSV to identify the affiliate partner.

Examples:

- `Cuelinks`
- `EarnKaro`
- `Amazon`
- `Direct`
- other partner names

Cuelinks CSV rows receive Cuelinks-specific validation:

1. Match the CSV Campaign ID against the current Cuelinks campaigns with `access_status=open`.
2. Require Cuelinks campaign country metadata.
3. Apply the normal Aviders status/start/end-date rules.
4. Enrich the offer with Cuelinks campaign and country metadata.

Non-Cuelinks rows are processed by the normal Aviders validation path and are not rejected because they are absent from Cuelinks.

The current legacy CSV predates `AF-partner`, so missing partner values are temporarily treated as `Cuelinks`. Once the column is populated, each row is routed according to its partner.

## Live Cuelinks offers

Every catalog build also calls:

`GET https://developers.cuelinks.com/pub_api/v3/offers`

with:

- `read:offers`
- `per_page=500`
- `valid_on=<today in Asia/Kolkata>`

Cuelinks V3 returns live offers only. The builder additionally checks the offer's campaign against the current open campaign map and uses the campaign's country metadata.

This means the final catalog can contain:

- manually supplied CSV offers;
- automatically discovered live Cuelinks offers;
- future offers from other affiliate partners.

The same deduplication process prevents the API copy and CSV copy of an offer from becoming two visible offers.

## Cuelinks API key

GitHub Actions reads the production key from the repository secret:

`CUELINKS_API_KEY`

The actual key must never be committed to the repository.

The workflow also supports the optional:

`CUELINKS_API_BASE=https://developers.cuelinks.com/pub_api/v3`

## Generated files

- `data/offers.json`: all active offers
- `data/coupons.json`: active offers with a coupon code
- `data/deals.json`: active offers without a coupon code
- `data/merchants.json`: merchant directory and counts
- `data/categories.json`: normalized category directory and counts
- `data/offers-manifest.json`: build metadata and validation statistics

Each offer includes `afPartner` and, when available, Cuelinks/country metadata such as `cuelinksCampaignId`, `countryIso`, `countryName`, and `countrySlug`.

## Expiry

An offer is published when its status is live (or blank), its start date is not in the future, and its end date is not before today.

Today is calculated in Asia/Kolkata. Cuelinks API offers are also requested with `valid_on` for today's date.

Expired offers are excluded from generated JSON; the raw CSV is never deleted.

## Updating

Replace `source/offers.csv` with the newest export and commit it to main. The workflow rebuilds automatically.

A daily scheduled run also rebuilds the catalog so offers disappear after their end date even if the CSV has not been replaced.

## Safety

The build fails rather than publishing an empty catalog.

If Cuelinks authentication/API calls fail, the build fails. This prevents an API outage from silently replacing the catalog with an unvalidated or incomplete Cuelinks dataset.

## Flutter

Base URL:

https://raw.githubusercontent.com/avidersonline-ux/aviders-affiliate-catalog/main/data/

The Android app can consume these JSON files and cache them in Hive.
