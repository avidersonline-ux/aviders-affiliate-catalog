# Aviders Affiliate & Config Catalog

This repository serves as the **Decoupled Configuration & Data Layer** for the Aviders App. It uses GitHub as a high-speed CDN to serve static JSON files that control the app's UI, homepage sections, and affiliate product catalog without requiring new App Store releases.

## 🚀 Key Configuration Files

### 1. `data/app_config.json`
This is the "Brain" of the app's homepage. It controls:

*   **Main Hero Sliders**: Manage images, videos, titles, and click actions for the top carousel.
*   **Partner Services**: Control the icons/images for the "Partner Services" row (Artist, NGOs, Tutors, etc.).
*   **Spend Options**: Manage the "Spend AVD Coins" screen grid.
*   **Section Visibility**: Enable/Disable homepage modules like "Spin & Win", "Basket", or specific product grids.

#### 🎨 How to update Partner & Spend Icons
The app now supports **Dynamic Full-Cover Cards**. To update an icon:
1. Upload your new image asset (Square/Portrait recommended).
2. In `app_config.json`, find the `id` (e.g., `artists`) inside `service_tiles` or `spend_options`.
3. Add or update the `image_url` field:
   ```json
   {
     "id": "artists",
     "title": "Artists",
     "image_url": "https://pub-4a5a79c47c2543f1b467c281dc42df40.r2.dev/AVD%20Partners/Service%20Icons/Artist.png",
     "action": { ... }
   }
   ```
   *If `image_url` is provided, it will show as a **Full Cover Card**. If omitted, it fallbacks to the default icon design.*

### 2. `data/products-XXXX.json`
Chunked catalog data for affiliate brands and products.
*   **Chunking**: Data is split into 100-item chunks (0001, 0002, etc.) for fast loading.
*   **Manifest**: `data/manifest.json` tracks the index and categories for these products.

---

## 🛠 Management Workflow

### Updating Images & Assets
- **External Hosting**: We currently use R2/Cloudflare for high-bandwidth images. 
- **GitHub Assets**: Small icons can be kept in an `/assets/` folder in this repo if needed.

### Deployment
1.  Commit changes to the `main` branch.
2.  GitHub Actions will automatically validate the JSON and deploy.
3.  Changes reflect in the app immediately after the cache refreshes.

### JSON Schema for Sliders
```json
{
  "type": "image", // or "video"
  "url": "https://...",
  "click_action": {
    "type": "deeplink", // or external_url, internal_route
    "value": "aviders://search/shoes"
  },
  "enabled": true
}
```

---

## 🔗 CDN Base URL
The app points to:
`https://raw.githubusercontent.com/avidersonline-ux/aviders-affiliate-catalog/main`

---
*Maintained by the Aviders UX & Backend Team.*
