# Aviders Coupons & Offers Catalog

Source: \`source/offers.csv\`

The CSV is kept unchanged. GitHub Actions converts it into app-friendly JSON.

## Generated files

- \`data/offers.json\`: all active offers
- \`data/coupons.json\`: active offers with a coupon code
- \`data/deals.json\`: active offers without a coupon code
- \`data/merchants.json\`: merchant directory and counts
- \`data/categories.json\`: normalized category directory and counts
- \`data/offers-manifest.json\`: build metadata

## Expiry

An offer is published when its status is live (or blank), its start date is not in the future, and its end date is not before today.

Today is calculated in Asia/Kolkata. Expired offers are excluded from generated JSON; the raw CSV is never deleted.

## Updating

Replace \`source/offers.csv\` with the newest export and commit it to main. The workflow rebuilds automatically.

A daily scheduled run also rebuilds the catalog so offers disappear after their end date even if the CSV has not been replaced.

## Flutter

Base URL:
https://raw.githubusercontent.com/avidersonline-ux/aviders-affiliate-catalog/main/data/

The Android app can consume these JSON files and cache them in Hive.
