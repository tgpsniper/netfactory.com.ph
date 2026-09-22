# Walled garden for restricted subscribers — deployment notes

Built 2026-09-10. **The application layer is live. The network layer is not, and until it
is, no customer will ever see this page.** Read "What is still missing" before assuming
this feature works.

## What was built

| Piece | Path | State |
|---|---|---|
| Notice + payment page | `/var/www/netfactory.com.ph/html/restricted/index.html` | live, serving 200 |
| Public API | `src/routes/restricted.js` → `/api/restricted` | live, mounted, tested |
| Pay-all restore fix | `src/routes/webhooks.js` | live (bug fix, see below) |

### How a caller is identified

There is no login. A cut-off customer is exactly the person who cannot look up their
portal password, so a login wall here is a wall in front of the money.

    client source IP → radacct (open session) → username = MAC
                     → hotspot_mac_devices.subscriber_id → subscriber
                     → subscriber_restrictions (lifted_at IS NULL)

Only sessions with `acctstoptime IS NULL` count. A closed session's address is back in
the pool and may belong to someone else — matching one would show a stranger's balance
to whoever inherited the lease.

What stands in for authentication is the network: the router only redirects addresses on
its `nf-restricted` list here. The page can therefore only describe the line the caller
is physically sitting on. That is the captive-portal trust model, and it has a real edge:
**anyone on that subscriber's WiFi sees the same page.** Hence the deliberately thin
payload — first name, account number, what is owed. No last name, address, phone, invoice
history or device list.

`POST /pay` never accepts an invoice id. It bills whatever that subscriber owes, resolved
server-side. Without that, an unauthenticated endpoint taking an id is an invoice
enumerator.

## Bug fixed on the way

`webhooks.js` had a `J2-PAYALL-` batch branch that marked every invoice paid, synced AR,
set the subscriber active — and `return`ed before reaching the `restoreIfSettled` call at
the bottom of the single-invoice path.

**A customer who settled through "Pay all" had their money taken and stayed cut off.**
That affected the existing portal button, not just this new page. Now fixed: the batch
branch lifts the restriction itself and reports `accessRestored` like the single path.

## What is still missing — the feature does nothing without this

### 1. Restriction mode is `full`

    system_settings.billing_restriction_mode = 'full'

`full` means RADIUS refuses the device outright and the firewall rejects its address —
the customer cannot reach the payment page either. That is what `full` is *for*.

For this feature to exist at all:

    UPDATE system_settings SET value = 'walled-garden' WHERE key = 'billing_restriction_mode';

**This is a collections policy decision, not a technical one.** A walled garden collects
from people who want to pay; a full cutoff applies more pressure. Your call.

### 2. There are no walled-garden rules on the router

Checked on CRM-DHCP (device 9, 36.50.30.110) on 2026-09-10:

- `nf-restricted` address list: **0 entries**
- filter rules `nf-restrict full cutoff (in/out)`: present but **disabled**
- NAT rules referencing `nf-restricted`: **none**

So today, restricting somebody changes their RADIUS group and adds an address to a list
that nothing acts on. The redirect that would put this page in front of them does not
exist. Everything below is **proposed and unapplied.**

Server address to allow: **36.50.30.102** (netfactory.com.ph).

#### a. Allow rules — insert BEFORE the two existing reject rules

    /ip/firewall/filter
    add chain=forward src-address-list=nf-restricted dst-address=36.50.30.102 \
        action=accept comment="nf-garden allow portal+api" place-before=[find comment="nf-restrict full cutoff (out)"]
    add chain=forward dst-address-list=nf-restricted src-address=36.50.30.102 \
        action=accept comment="nf-garden allow portal+api (return)" place-before=[find comment="nf-restrict full cutoff (out)"]
    add chain=forward src-address-list=nf-restricted protocol=udp dst-port=53 \
        action=accept comment="nf-garden allow DNS" place-before=[find comment="nf-restrict full cutoff (out)"]
    add chain=forward src-address-list=nf-restricted protocol=tcp dst-port=53 \
        action=accept comment="nf-garden allow DNS/tcp" place-before=[find comment="nf-restrict full cutoff (out)"]
    add chain=forward src-address-list=nf-restricted dst-address-list=nf-garden \
        action=accept comment="nf-garden allow payment hosts" place-before=[find comment="nf-restrict full cutoff (out)"]
    add chain=forward dst-address-list=nf-restricted src-address-list=nf-garden \
        action=accept comment="nf-garden allow payment hosts (return)" place-before=[find comment="nf-restrict full cutoff (out)"]

Then enable the two reject rules so everything else is refused:

    /ip/firewall/filter enable [find comment~"nf-restrict full cutoff"]

#### b. The payment allow-list — the part that needs real testing

    /ip/firewall/address-list
    add list=nf-garden address=checkout.xendit.co  comment="nf-garden xendit"
    add list=nf-garden address=api.xendit.co       comment="nf-garden xendit"

RouterOS resolves FQDN entries and keeps them current, which is the only workable
approach — Xendit and the e-wallets sit behind CDNs with rotating addresses.

**This list is a starting point, not a finished one.** A Xendit checkout pulls in the
wallet redirect targets (GCash, Maya, GrabPay, ShopeePay), their CDNs and their 3-D Secure
hops. The honest way to complete it is to restrict one willing test account, walk a real
payment through on each wallet, and read what got rejected out of the router log:

    /system logging add topics=firewall action=memory
    /log print where message~"nf-restrict"

Do not assume the two entries above are sufficient. They are not.

#### c. Captive redirect, so the page opens by itself

Without this the customer sees timeouts and has to type the URL. Phones and laptops probe
a known HTTP URL to detect captive portals; catching that probe is what makes
"Sign in to network" appear.

    /ip/firewall/nat
    add chain=dstnat src-address-list=nf-restricted protocol=tcp dst-port=80 \
        dst-address=!36.50.30.102 action=dst-nat to-addresses=36.50.30.102 to-ports=8081 \
        comment="nf-garden captive redirect"

Port **8081**, not 80, on purpose. Port 80 on that host is `00-catchall`, which returns
444 to scanners; pointing captive probes at it would either break the redirect or force a
change to how the server answers the open internet. A dedicated block keeps the two apart:

    server {
        listen 8081;
        server_name _;
        return 302 https://netfactory.com.ph/restricted/;
    }

HTTPS is deliberately not intercepted. Transparently intercepting 443 means a certificate
error on every site the customer opens, which reads as "my ISP is attacking me". The HTTP
probe is the correct hook.

## Verified so far

Against the live database and a real subscriber session:

- `/status` from an unknown address → `identified:false`, no account data leaked
- `/status` from a real live session IP (100.66.48.11) → correctly resolved to account
  2607242406, `restricted:false`
- restricted branch, mocked: reason, amount, per-invoice days-overdue, `canPayOnline`
- `/pay` guards: 403 unidentified, 400 not restricted, 400 nothing owed
- page + logo + API all serve 200 through nginx
- page loads **zero external resources** — no CDN, no web font. A firewalled customer
  cannot reach a CDN, and a page waiting on one is a blank page.

## NOT verified

- **No live Xendit checkout has been created from this endpoint.** Doing so bills a real
  customer. The Xendit call is copied from the portal's proven `pay-all` path and uses the
  same `J2-PAYALL-` external-id convention so the existing webhook settles it, but the
  round trip is untested.
- No end-to-end run with a genuinely restricted subscriber. There are 0 open restrictions,
  and creating one would cut off a real customer — the `restriction-sync` job runs every
  5 minutes and would push their address to the router.

## Rollback

    # API
    rm src/routes/restricted.js
    cp src/server.js.bak-walledgarden-20260910 src/server.js
    cp src/routes/webhooks.js.bak-walledgarden-20260910 src/routes/webhooks.js
    pm2 restart isp-api

    # page
    rm -rf /var/www/netfactory.com.ph/html/restricted

Note the webhooks backup also reverts the pay-all restore fix, which you probably want to
keep regardless of what happens to the walled garden.

---

# 2026-09-15 — why no customer ever saw this page, and what was fixed

Staff restricted a live subscriber from the CRM on 2026-09-15 00:28 and the customer
noticed nothing. Investigation found **four** independent faults, any one of which alone
was enough to stop the walled garden working for anybody.

Subscriber 190, account 2608000649, MAC `70:22:96:2A:A4:24`, address `100.66.48.10`,
session on NAS `192.168.97.21` = CLGNT-AC1.

### 1. Enforcement always targeted the wrong router — the fault that mattered

`getRouterDeviceId()` picked the lowest active device id, with a comment reading "One
active router today." There are now 16, and it always returned **device 9, CRM-DHCP**.

    devices on device 9 (the only router with garden rules):   0
    total registered subscriber devices:                      88

Every subscriber is behind one of the 13 access concentrators. So every address-list
write landed on a router that could not see the traffic it was meant to restrict, and
`nf-restricted` was empty on all 15 reachable routers. This was never specific to one
customer: **the walled garden could not work for anyone, and neither could `full` mode.**
Only `billing_auto_restrict_enabled=false` kept it from surfacing sooner.

**Fixed** in `src/utils/restriction.js`. Enforcement now resolves the router per
subscriber from the session RADIUS already records:

    radacct.framedipaddress -> the address to restrict
    radacct.nasipaddress    -> nas.nasname -> nas.shortname -> mikrotik_devices.label

Joined on shortname/label, not address: the NAS-IP-Address a router sends is its internal
MGMT address (192.168.9x.x) while `mikrotik_devices.host` is the public address its API
answers on. Those differ on every device here. Verified to resolve all 13 NAS addresses
covering all 88 devices. `getRouterDeviceId()` is kept only for the DHCP-server callers
(`device-release.js`, and previously `nf-paying`).

`syncAddressList` now reconciles **every** active router, not just those with someone
restricted — a device that moves between concentrators leaves its entry behind, and an
entry nobody clears keeps whoever inherits that address inside the garden. Four routers
at a time: a burst of sixteen RouterOS API connects times each other out.

### 2. Device 9's API port is closed

`36.50.30.110` pings but refuses 8728, so even the wrong-router write failed:

    [restriction] apply address-list failed: MikroTik connect failed for device 9
    [jobs] restriction-sync failed: MikroTik connect failed for device 9

Still unfixed — needs someone on the router. It is harmless now that enforcement no
longer depends on it, but while it is `is_active` every sync logs a failure against it.
Either re-enable the API service or clear `is_active`.

### 3. The access routers have no walled-garden rules

CLGNT-AC1 live: 15 filter rules, 3 NAT rules, **zero** referencing `nf-garden` or
`nf-restricted`. Same on CLGNT-AC2 and MCB-AC1. `walled-garden-apply.rsc` was only ever
applied to device 9, and cannot be pasted into these routers anyway — it depends on two
cutoff rules that exist only there.

**Still outstanding.** See `walled-garden-access-routers.rsc` (paste-able) or
`scripts/apply-walled-garden.js --devices <id|all>` (idempotent, verifies ordering,
`--dry-run` and `--rollback` supported).

Ordering is the whole feature on these routers. They release customer traffic with

    accept src-address-list=NAT out-interface=sfp-sfpplus2   ("Forward NAT pool, new conn")

so every rule must be placed ABOVE it or a restricted customer keeps full internet; and
every accept must sit above both drops, or the customer loses their connection AND the
payment page. The script refuses to run if it cannot find that anchor rule rather than
guessing placement.

### 4. src-NAT hid the customer's identity from the payment page

`identify()` matches the caller's source address against `radacct.framedipaddress`. But
CLGNT src-NATs customers to `36.50.30.192/29`, so every restricted customer would have
arrived as `36.50.30.197` and the page could not have told any of them what they owed.
Confirmed in nginx logs: not one `100.6x` source address has ever appeared.

Handled by a `srcnat action=accept` for `nf-restricted -> nf-portal` in the new rule set,
scoped so it changes nothing for anyone who is not cut off.

### Also fixed

- `openPaymentWindow()` in `routes/restricted.js` had the same wrong-router bug. It would
  have punched the `nf-paying` hole in device 9 while the customer sat on CLGNT-AC1, so a
  card payment would have died at 3-D Secure. Now resolves the router from the address.
- A restriction lifted while a router was unreachable left that address stranded forever:
  `restriction-sync` skips its work entirely when nobody is restricted, so no later run
  would ever look. A `needsSweep` flag now keeps the job returning until every router is
  clear — a stale entry is a customer who has paid and is still walled in.

### Verified after the fix

    [restriction-sync] drift corrected — added ["100.66.48.10@CLGNT-AC1"]
    /ip/firewall/address-list on CLGNT-AC1 -> nf-restricted 100.66.48.10   (was device 9)
    GET /api/restricted/status as 100.66.48.10
      -> identified, account 2608000649, PHP 999, 16 days overdue, canPayOnline
    GET /api/restricted/status as an unknown address -> identified:false, nothing leaked

Everything except the router rules is now live. Until those are applied the customer
still sees no change — the address is on the right list, but no rule acts on that list.

## Rollout completed 2026-09-15

Rules applied and verified on **all 15 reachable routers** — every one reporting
8 accepts, 2 drops, all accepts above both drops, both drops above the NAT-pool accept:

    11 SMN-AC3    12 MCB-AC1    13 MCB-AC2    14 MCB-AC3    15 MCB-AC4
    16 MCB-AC5    17 MCB-AC6    18 MCB-AC7    19 MCB-AC8    20 CLGNT-AC1
    21 CLGNT-AC2  22 SMN-AC1    23 SMN-AC2    24 STMS-AC1   26 SFP-AC1

Only five of these label the anchor rule `Forward NAT pool, new conn`; the rest leave it
uncommented. `apply-walled-garden.js` therefore matches the anchor structurally — the
first forward `accept` scoped to `src-address-list=NAT` — and still refuses to run rather
than guess if it finds none.

Confirmed live on CLGNT-AC1 with the restricted subscriber's own traffic:

    nf-garden allow portal   pkts=4
    nf-garden allow DNS      pkts=2
    nf-garden cutoff (out)   pkts=0   (she is idle: 4.8 MB in 19 hours)

### Still outstanding

**1. The captive redirect is applied DISABLED on every router, and must stay that way
until the edge forwards port 8081.**

`127.0.0.1:8081` answers 302 correctly, but `36.50.30.102:8081` refuses the connection,
and `walled-garden-access.log` has never recorded one external hit. The edge (10.0.98.1)
is not in `mikrotik_devices`, has no API port open, and was not touched. Redirecting
customers to a port nothing forwards would turn every blocked HTTP request into
connection-refused. Once the edge forwards 8081 to 10.0.98.4:

    /ip/firewall/nat enable [find comment="nf-garden captive redirect"]

Until then the garden still works — the customer reaches the portal by typing the
address. They just do not get the automatic "Sign in to network" prompt.

**2. Source preservation is applied but unproven.** The `srcnat accept` is in place on
all 15 routers, but no restricted customer has yet loaded the portal, so no `100.6x`
address has appeared in the nginx logs. If it turns out not to survive the edge, the page
will load and say it cannot identify the connection rather than showing the balance.
Check with:

    grep -hE "^100\.6[0-9]\." /var/log/nginx/*access*.log

Two paths were tested and ruled out on the way:
- ICMP to 36.50.30.102 is answered by the edge, not this server, so it cannot be used to
  test source preservation at all.
- The internal route (10.0.98.0/24 via VLAN97-MGMT) does NOT carry customer-sourced
  traffic — a ping from CLGNT-AC1 sourced as 100.66.48.1 reached the server zero times
  (tcpdump, 0 packets). So the redirect cannot be pointed at 10.0.98.4.

**3. Device 9 (CRM-DHCP) is still unreachable** — pings, refuses 8728. It carries no
subscribers, so nothing depends on it, but every sync logs a failure against it while it
is `is_active`.
