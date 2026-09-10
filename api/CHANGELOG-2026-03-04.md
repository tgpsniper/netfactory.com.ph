# Changelog — March 4, 2026

## Summary

Bug fixes, data corrections, feature enhancements, and subscriber data import for the J2 Network CRM/Billing system.

---

## Bug Fixes

### 1. Invoice Search Not Working from Subscriber Profile
**Files:** `crm/index.html`, `admin.js`

- **Problem:** Clicking "View Invoices" from a subscriber profile showed 0 results because:
  - The frontend only fetched 100 invoices (out of 211 total), so many subscribers' invoices were missing
  - The invoices API did not return `subscriberId`, causing `getSub()` lookups to fail
  - The Billing page had no visible search bar — filtering happened silently with no way to see or clear the search
  - Clicking any status filter tab silently cleared the search
  - Page number was not reset to 1 when navigating from subscriber profile
- **Fix:**
  - Increased invoice fetch limit from `100` to `500` in `fetchCrmData()`
  - Added `subscriberId` and `subscriber.id` to `GET /api/admin/invoices` response
  - Added search bar with icon, clear button, and result count between status filters and invoice table
  - Added `setInvoicePage(1)` to "View Invoices" button handler

### 2. TableHead Component Not Forwarding Click Events
**File:** `crm/index.html` (line 85)

- **Problem:** `_TableHead` component only destructured `children`, `style`, and `t`, discarding all other props including `onClick`
- **Fix:** Added `...rest` spread to forward all additional props to the `<th>` element

---

## New Features

### 3. Billing Page Search Bar
**File:** `crm/index.html`

Added a search input to the Billing/Invoices page:
- Search icon with text input field
- Filters by invoice number, subscriber name, or account number
- Clear button (X icon) to reset search
- Result count display (e.g., "2 results")
- Resets pagination to page 1 on search change

### 4. Subscriber Table Sorting
**File:** `crm/index.html`

Added clickable column sort headers to the Subscribers table:
- **Sortable columns:** Account, Name, Plan, Barangay, Status, Balance
- Click a column header to sort ascending; click again to toggle descending
- Active sort column highlighted with directional arrow icon
- Name sorts by last name then first name
- Balance sorts numerically; all others sort alphabetically
- Resets to page 1 on sort change

**State variables added:**
- `subSortKey` (default: `"acct"`)
- `subSortDir` (default: `"asc"`)

---

## Data Corrections

### 5. Payment Date Correction — PYM2603000012
**Table:** `payments` (id: 152)

- **Invoice:** INV-26030198 (Joel Nisay, ₱1,500)
- **Changed:** `paid_at` from `2025-01-08` → `2026-01-08`

### 6. Payment Amount Correction — PYM2603000024
**Table:** `payments` (id: 168)

- **Invoice:** INV-26030016 (Maricris Ison Caraan, ₱135)
- **Changed:** `amount` from `362` → `335`

---

## Configuration Changes

### 7. GeoIP Blocking Disabled
**Table:** `system_settings` (id: 2035)

- **Changed:** `geoblock_enabled` from `true` → `false`
- All regions can now access the site (previously restricted to PH and US)
- No API restart needed — middleware reads toggle per-request

---

## Data Import

### 8. Subscriber Bulk Import (56 Records)
**Table:** `subscribers`

Imported 56 new subscriber records from spreadsheet data:
- **54 Active**, **2 Suspended** (Caraan Benedicta, Lagadia Jinefer)
- **Barangays:** Cabog-Cabog, Pantingan, Tanato, Diwa
- **Plans:** BA+Plan 999, BA+Plan 1500, BA+Plan 2500, BA+Plan 3500, SuLit-Stream 1200

**Skipped (2 conflicts):**
| Account | Name | Reason |
|---------|------|--------|
| 0000500096 | Ambat, Mary Rose Mendoza | Already exists in DB |
| 0000500009 | Lacorte, Adelaida Carable | Duplicate account number with Bernatia, Jay Aries Tadioan (inserted first) |

---

## Files Modified

| File | Changes |
|------|---------|
| `/var/www/netfactory.com.ph/html/crm/index.html` | Search bar, sort headers, TableHead fix, fetch limit, View Invoices button fix, sort state variables |
| `/home/ashraf/Node.js_API/j2-api/src/routes/admin.js` | Added `subscriberId` and `subscriber.id` to invoices API response |

## Database Changes

| Table | Records | Action |
|-------|---------|--------|
| `payments` (id: 152) | 1 | Updated `paid_at` |
| `payments` (id: 168) | 1 | Updated `amount` |
| `system_settings` (id: 2035) | 1 | Updated `value` (geoblock) |
| `subscribers` | 56 | Inserted new records |
