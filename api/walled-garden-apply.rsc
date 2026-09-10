# ============================================================
# Walled garden — apply on CRM-DHCP (device 9, 36.50.30.110)
# ============================================================
# Paste into the router's terminal (WinBox > New Terminal, or SSH).
#
# SAFE TO RUN NOW: every rule below is scoped to src/dst-address-list=nf-restricted,
# and that list is EMPTY (verified 2026-09-10). So nothing changes for any live
# customer until someone is actually restricted. Re-check before running:
#
#     /ip/firewall/address-list print where list=nf-restricted
#
# If that returns anything, someone IS restricted and these rules take effect on them
# the moment you paste this. Read the ordering check at the bottom before you do.
#
# Backup of the pre-change state: backups-router-9-20260910.json
# ============================================================

# ── 1. payment allow-list ───────────────────────────────────
# FQDN entries — RouterOS resolves these and keeps them current, which is the only
# workable approach against CDN-backed hosts with rotating addresses.
/ip/firewall/address-list
add list=nf-garden address=checkout.xendit.co comment="nf-garden payment host"
add list=nf-garden address=api.xendit.co comment="nf-garden payment host"

# ── 2. allow rules — MUST sit above the cutoff rules ────────
# place-before pins them ahead of the reject, which is the whole ballgame: appended to
# the end they would sit below it and never match.
/ip/firewall/filter
add chain=forward src-address-list=nf-restricted dst-address=36.50.30.102 action=accept \
    comment="nf-garden allow portal+api" place-before=[find comment="nf-restrict full cutoff (out)"]
add chain=forward dst-address-list=nf-restricted src-address=36.50.30.102 action=accept \
    comment="nf-garden allow portal+api (return)" place-before=[find comment="nf-restrict full cutoff (out)"]
add chain=forward src-address-list=nf-restricted protocol=udp dst-port=53 action=accept \
    comment="nf-garden allow DNS" place-before=[find comment="nf-restrict full cutoff (out)"]
add chain=forward src-address-list=nf-restricted protocol=tcp dst-port=53 action=accept \
    comment="nf-garden allow DNS tcp" place-before=[find comment="nf-restrict full cutoff (out)"]
add chain=forward src-address-list=nf-restricted dst-address-list=nf-garden action=accept \
    comment="nf-garden allow payment hosts" place-before=[find comment="nf-restrict full cutoff (out)"]
add chain=forward dst-address-list=nf-restricted src-address-list=nf-garden action=accept \
    comment="nf-garden allow payment hosts (return)" place-before=[find comment="nf-restrict full cutoff (out)"]

# ── 3. captive redirect ─────────────────────────────────────
# Catches the plain-HTTP probe phones and laptops use to detect a captive portal. This is
# what makes "Sign in to network" pop instead of a wall of timeouts.
# DO NOT RUN THIS until the nginx :8081 listener exists (step 5 in the chat) — without it
# the redirect lands on a closed port and the customer gets connection-refused.
/ip/firewall/nat
add chain=dstnat src-address-list=nf-restricted protocol=tcp dst-port=80 \
    dst-address=!36.50.30.102 action=dst-nat to-addresses=36.50.30.102 to-ports=8081 \
    comment="nf-garden captive redirect"

# ── 4. turn the cutoff on ───────────────────────────────────
# Run LAST. Until this, restricted customers keep full internet.
/ip/firewall/filter
enable [find comment="nf-restrict full cutoff (out)"]
enable [find comment="nf-restrict full cutoff (in)"]

# ── 5. verify the ordering ──────────────────────────────────
# Every nf-garden accept MUST appear ABOVE both nf-restrict rejects. If any accept is
# below a reject, restricted customers cannot reach the payment page and the feature is
# worse than useless — it takes their internet and gives them no way to pay.
/ip/firewall/filter print where chain=forward

# ── rollback ────────────────────────────────────────────────
# /ip/firewall/filter disable [find comment~"nf-restrict full cutoff"]
# /ip/firewall/filter remove [find comment~"nf-garden"]
# /ip/firewall/nat remove [find comment~"nf-garden"]
# /ip/firewall/address-list remove [find list=nf-garden]
