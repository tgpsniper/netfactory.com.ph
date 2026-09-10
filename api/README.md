# J2 Network API

Backend API for J2 Network & Data Solution ISP platform.

**Platforms:** Public Website • Customer Portal • CRM Admin Dashboard  
**Stack:** Node.js + Express + Prisma ORM + PostgreSQL 16

---

## Quick Start (Server Deployment)

### 1. Upload project to server

```bash
scp -r j2-api/ ubuntu@YOUR_SERVER_IP:/home/ubuntu/j2-api
```

### 2. Install dependencies

```bash
cd /home/ubuntu/j2-api
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
```

Update `DATABASE_URL` with your PostgreSQL credentials and set a strong `JWT_SECRET`.

### 4. Generate Prisma client

```bash
npx prisma generate
```

### 5. Seed sample data

```bash
node src/utils/seed.js
```

### 6. Test the API

```bash
# Quick test
node src/server.js

# Check health endpoint
curl http://localhost:3001/api/health

# Check plans
curl http://localhost:3001/api/public/plans
```

### 7. Run with PM2 (production)

```bash
npm install -g pm2
pm2 start src/server.js --name j2-api
pm2 startup
pm2 save
```

### 8. Configure Nginx reverse proxy

Add to your existing `/etc/nginx/sites-available/jedapps.com` inside the HTTPS server block:

```nginx
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
```

```bash
sudo nginx -t
sudo systemctl restart nginx
```

---

## API Endpoints

### Public (no auth)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/public/plans` | Active plans for website |
| GET | `/api/public/plans/:slug` | Single plan detail |
| GET | `/api/public/coverage` | Serviceable areas |
| POST | `/api/public/apply` | New subscriber application |
| GET | `/api/public/settings` | Company info |
| GET | `/api/health` | Server health check |

### Customer Portal (subscriber JWT)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/portal/login` | Login (account + password) |
| POST | `/api/portal/logout` | End session |
| POST | `/api/portal/forgot-password` | Request password reset |
| GET | `/api/portal/dashboard` | Account summary |
| GET | `/api/portal/invoices` | Invoice history |
| GET | `/api/portal/usage` | 30-day bandwidth data |
| GET | `/api/portal/plan` | Current + all plans |
| POST | `/api/portal/plan/change` | Request plan change |
| GET | `/api/portal/tickets` | My tickets |
| POST | `/api/portal/tickets` | Create ticket |
| GET | `/api/portal/account` | Account details |
| PUT | `/api/portal/account` | Update profile |
| POST | `/api/portal/change-password` | Change password |

### CRM Admin (admin JWT)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/login` | Staff login |
| GET | `/api/admin/dashboard` | KPI stats |
| GET | `/api/admin/subscribers` | List (search/filter/paginate) |
| GET | `/api/admin/subscribers/:id` | Subscriber detail |
| POST | `/api/admin/subscribers` | Add subscriber |
| PUT | `/api/admin/subscribers/:id` | Update subscriber |
| GET | `/api/admin/invoices` | All invoices |
| POST | `/api/admin/invoices/generate` | Monthly batch generation |
| GET | `/api/admin/tickets` | All tickets |
| PUT | `/api/admin/tickets/:id` | Update ticket |
| GET | `/api/admin/plans` | All plans (inc. inactive) |
| PUT | `/api/admin/plans/:id` | Edit plan (enable/disable) |
| POST | `/api/admin/plans` | Create new plan |
| GET | `/api/admin/reports/:type` | Reports (revenue/collection/subscribers/tickets) |
| GET | `/api/admin/map/nodes` | Network nodes |
| GET | `/api/admin/map/routes` | Fiber routes |
| GET | `/api/admin/map/subscribers` | Subscriber GIS pins |
| GET | `/api/admin/notifications` | CRM alerts |
| PUT | `/api/admin/notifications/:id/read` | Mark as read |
| GET | `/api/admin/settings` | System settings |
| PUT | `/api/admin/settings` | Update settings |
| GET | `/api/admin/staff` | Staff list |
| POST | `/api/admin/staff` | Create staff |

### Payment Webhooks
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/xendit` | Xendit callback |
| POST | `/api/webhooks/gcash` | GCash callback |
| POST | `/api/webhooks/maya` | Maya callback |
| POST | `/api/webhooks/manual` | Manual payment recording |

---

## Default Credentials

**CRM Admin:**  
Username: `admin` | Password: `changeme123`

**Customer Portal (after seeding):**  
Account: `J2-2026-XXXX` | Password: `demo123`

⚠️ Change all default passwords after first login!
