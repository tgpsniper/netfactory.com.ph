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
