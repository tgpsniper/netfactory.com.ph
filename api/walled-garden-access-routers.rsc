# ============================================================
# Walled garden — ACCESS CONCENTRATORS (CLGNT-AC1/2, MCB-AC1..8, SMN-AC1..3,
# STMS-AC1, SFP-AC1).  Generated 2026-09-15.
# ============================================================
# Use this instead of walled-garden-apply.rsc. That file was written for CRM-DHCP
# (device 9) and references two cutoff rules that already existed there; no access
# router has them. It also does not matter what device 9 does — 0 of the 88 registered
# subscriber devices are behind it. All of them are behind these routers.
#
# WHY IT HAS TO BE THESE ROUTERS
#   Restriction pins the customer's CURRENT address to the address-list nf-restricted.
#   That address only exists on the router terminating their session. Enforcement used
#   to always write to device 9, so nothing ever matched. Fixed in src/utils/restriction.js.
#
# ORDERING IS THE WHOLE FEATURE
#   These routers let customer traffic out with
#       accept src-address-list=NAT out-interface=sfp-sfpplus2  ("Forward NAT pool, new conn")
#   Every rule below is placed ABOVE that rule. Below it, a restricted customer keeps
#   full internet. And every accept must sit above both drops — the other way round the
#   customer loses their connection AND the payment page, which is worse than not
#   restricting them at all.
#
# SAFE TO RUN WHEN nf-restricted IS EMPTY. Check first:
#     /ip/firewall/address-list print where list=nf-restricted
#   On CLGNT-AC1 it currently holds 100.66.48.10 (subscriber 190, restricted 2026-09-15),
#   so on THAT router these rules take effect the moment you paste them. That is the
#   intent — verify the ordering print at the bottom before walking away.
#
# Rollback is at the end of this file.
# ============================================================

# ── 1. destinations a restricted customer may still reach ───
/ip/firewall/address-list
add list=nf-portal address=36.50.30.102 comment="nf-garden portal (public)"
add list=nf-portal address=10.0.98.4 comment="nf-garden portal (internal)"
# FQDN entries: RouterOS resolves and refreshes these itself, the only workable approach
# against CDN-backed hosts whose addresses rotate.
add list=nf-garden address=checkout.xendit.co comment="nf-garden payment host"
add list=nf-garden address=api.xendit.co comment="nf-garden payment host"

# ── 2. filter rules, in this order, all above the NAT-pool accept ──
/ip/firewall/filter
add chain=forward action=accept src-address-list=nf-restricted dst-address-list=nf-portal \
    comment="nf-garden allow portal" place-before=[find comment="Forward NAT pool, new conn"]
add chain=forward action=accept dst-address-list=nf-restricted src-address-list=nf-portal \
    comment="nf-garden allow portal (return)" place-before=[find comment="Forward NAT pool, new conn"]
add chain=forward action=accept src-address-list=nf-restricted protocol=udp dst-port=53 \
    comment="nf-garden allow DNS" place-before=[find comment="Forward NAT pool, new conn"]
add chain=forward action=accept src-address-list=nf-restricted protocol=tcp dst-port=53 \
    comment="nf-garden allow DNS tcp" place-before=[find comment="Forward NAT pool, new conn"]
add chain=forward action=accept src-address-list=nf-restricted dst-address-list=nf-garden \
    comment="nf-garden allow payment hosts" place-before=[find comment="Forward NAT pool, new conn"]
add chain=forward action=accept dst-address-list=nf-restricted src-address-list=nf-garden \
    comment="nf-garden allow payment hosts (return)" place-before=[find comment="Forward NAT pool, new conn"]
# The timed payment window. A checkout cannot complete inside a domain allow-list —
# 3-D Secure lands on the cardholder's own bank, different for every customer — so
# /api/restricted/pay parks the address in nf-paying for 20 minutes. MUST be above the drops.
add chain=forward action=accept src-address-list=nf-paying \
    comment="nf-garden payment window" place-before=[find comment="Forward NAT pool, new conn"]
add chain=forward action=accept dst-address-list=nf-paying \
    comment="nf-garden payment window (return)" place-before=[find comment="Forward NAT pool, new conn"]
# The cutoff itself. Everything not accepted above is refused here.
add chain=forward action=drop src-address-list=nf-restricted \
    comment="nf-garden cutoff (out)" place-before=[find comment="Forward NAT pool, new conn"]
add chain=forward action=drop dst-address-list=nf-restricted \
    comment="nf-garden cutoff (in)" place-before=[find comment="Forward NAT pool, new conn"]

# ── 3. NAT ──────────────────────────────────────────────────
/ip/firewall/nat
# srcnat accept = "do not NAT this". Without it the customer reaches the portal as the
# router's NAT pool address (36.50.30.197 on CLGNT), and /api/restricted identifies
# callers by matching the source address against radacct — so every restricted customer
# would look like the same stranger and the page could not tell them what they owe.
# Scoped to nf-restricted, so nothing changes for anybody who is not cut off.
add chain=srcnat action=accept src-address-list=nf-restricted dst-address-list=nf-portal \
    comment="nf-garden preserve source to portal" place-before=[find chain=srcnat action=src-nat]
# Catches the plain-HTTP probe phones and laptops fire to detect a captive portal, which
# is what makes "Sign in to network" appear instead of a wall of timeouts.
# HTTPS is deliberately NOT intercepted: that means a certificate error on every site the
# customer opens, which reads as the ISP attacking them.
#
# ADDED DISABLED on purpose. The listener answers on the server (127.0.0.1:8081 -> 302)
# but the EDGE DOES NOT FORWARD 8081 from 36.50.30.102 — verified 2026-09-15, and that
# listener's access log has never recorded one external hit. Redirecting customers to a
# port nothing forwards turns every blocked HTTP request into connection-refused.
# Once the edge forwards 8081 to 10.0.98.4:8081, enable it:
#     /ip/firewall/nat enable [find comment="nf-garden captive redirect"]
add chain=dstnat action=dst-nat src-address-list=nf-restricted protocol=tcp dst-port=80 \
    dst-address-list=!nf-portal to-addresses=36.50.30.102 to-ports=8081 disabled=yes \
    comment="nf-garden captive redirect"

# ── 4. verify — read this before walking away ───────────────
# Every "nf-garden allow/payment" accept MUST appear ABOVE both "nf-garden cutoff" drops,
# and both drops MUST appear ABOVE "Forward NAT pool, new conn".
/ip/firewall/filter print where chain=forward

# ── rollback ────────────────────────────────────────────────
# /ip/firewall/filter remove [find comment~"nf-garden"]
# /ip/firewall/nat remove [find comment~"nf-garden"]
# /ip/firewall/address-list remove [find list=nf-garden]
# /ip/firewall/address-list remove [find list=nf-portal]
