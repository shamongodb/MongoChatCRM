#!/usr/bin/env bash
# Push local code to the Apps Script project. After this, update the Web app
# to use the new version in the Google Apps Script UI (see PROJECT.md).

set -e
cd "$(dirname "$0")"

echo "Pushing to Apps Script project..."
clasp push

echo ""
echo "Done. Next step: point the Web app at the new code."
echo "  1. Open https://script.google.com and your project."
echo "  2. Deploy → Manage deployments → Edit (pencil) your Web app."
echo "  3. Version → New version → Deploy."
echo "  4. Hard-refresh the Web app URL (or open in incognito) if you still see the old UI."
