#!/bin/bash
# ============================================================
# Patch admin.js — Add activationFee + showFeesOnWebsite
# Run from: /home/ubuntu/Node.js_API/j2-api
# Usage: bash patch_plan_fees.sh
# ============================================================

FILE="src/routes/admin.js"
BACKUP="src/routes/admin.js.bak_$(date +%Y%m%d_%H%M%S)"

# Backup first
cp "$FILE" "$BACKUP"
echo "✅ Backup saved: $BACKUP"

# ── PATCH 1: PUT route — add to destructuring ──
sed -i 's/installationFee, features/installationFee, activationFee, showFeesOnWebsite, features/' "$FILE"

# ── PATCH 2: PUT route — add fields after installationFee line ──
sed -i '/installation_fee = parseFloat(installationFee)/a\    if (activationFee !== undefined) data.activation_fee = parseFloat(activationFee);\n    if (showFeesOnWebsite !== undefined) data.show_fees_on_website = showFeesOnWebsite;' "$FILE"

# ── PATCH 3: POST route — add to destructuring ──
sed -i 's/sortOrder, routerType, features/sortOrder, routerType, installationFee, activationFee, showFeesOnWebsite, features/' "$FILE"

# ── PATCH 4: POST route — add fields to create block ──
sed -i "/router_type: routerType || null/a\\        installation_fee: parseFloat(installationFee) || 0,\n        activation_fee: parseFloat(activationFee) || 0,\n        show_fees_on_website: showFeesOnWebsite || false," "$FILE"

echo "✅ Patched: $FILE"
echo ""
echo "Verify the changes:"
echo "  grep -n 'activationFee\|activation_fee\|showFeesOnWebsite\|show_fees_on_website' $FILE"
echo ""
echo "Then restart:"
echo "  pm2 restart j2-api --update-env"
