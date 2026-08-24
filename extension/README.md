# AutoVINReveal — VIN Checker (Chrome / Edge extension)

Detects 17-character VINs on car listing pages (Facebook Marketplace, Craigslist,
eBay Motors, Cars.com, Autotrader, CarGurus, OfferUp, CarMax) and offers a
one-click history check. Also adds a right-click "Check this VIN's history" menu
on any selected text, and a popup that decodes a VIN for free.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.

## Publishing to the Chrome Web Store

1. Zip the contents of this folder (not the folder itself).
2. Go to the Chrome Web Store Developer Dashboard, pay the one-time developer
   fee if you have not already, and upload the zip.
3. You will need a 128x128 icon, at least one 1280x800 screenshot, and a privacy
   policy URL — use https://www.autovinreveal.com/privacy.html.

## Privacy

The extension sends a VIN to https://www.autovinreveal.com only when the user explicitly clicks
decode or opens a report. It does not collect browsing history and has no
analytics.
