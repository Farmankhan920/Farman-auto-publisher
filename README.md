# Farman Auto Publisher – Official Website

Static website (HTML, CSS, vanilla JS) for Vercel. No build step, no environment variables.

## Structure

```
index.html
terms-of-service/index.html
privacy-policy/index.html
data-deletion/index.html
contact/index.html
assets/css/style.css
assets/js/main.js
assets/images/favicon.png
assets/images/favicon.svg
robots.txt
sitemap.xml
vercel.json
```

## Before going live

1. Replace `YOUR-DOMAIN.vercel.app` in every HTML file, `robots.txt` and `sitemap.xml` with your real domain.
2. Replace `your-email@example.com` with your real support email.
3. Replace each highlighted `[PLACEHOLDER]` in the legal pages with accurate details.

## TikTok URL verification file

Download the verification file from the TikTok Developer Portal and upload it to the ROOT of this repository (next to `index.html`) with its EXACT filename and unchanged contents. It will then be served at `https://YOUR-DOMAIN.vercel.app/EXACT-FILENAME` without redirects.

Do not use `cleanUrls` in `vercel.json`; it would redirect `.html` verification files.

## Deploy

Vercel > Add New > Project > import the GitHub repo > Framework Preset: Other > leave Build Command and Output Directory empty > Deploy.
