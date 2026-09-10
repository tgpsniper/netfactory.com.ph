// ============================================================
// NETFACTORY — Database Configuration (Prisma Singleton)
// ============================================================
// Usage:
//   const { db } = require('../config');
//   const user = await db.prisma.subscribers.findUnique({ ... });
//
//   // Or attach as middleware:
//   app.use(db.middleware());
// ============================================================

const { PrismaClient } = require('@prisma/client');

let prisma = null;

/**
 * Get or create the Prisma client singleton.
 * Reuses the same instance across all imports.
 */
function getClient() {
  if (!prisma) {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'production'
        ? ['error', 'warn']
        : ['query', 'info', 'warn', 'error'],
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
    });
  }
  return prisma;
}

/**
 * Connect to the database.
 * Call this once during server startup.
 */
async function connect() {
  const client = getClient();
  await client.$connect();
  console.log('✅ Database connected');
  return client;
}

/**
 * Disconnect from the database.
 * Call this during graceful shutdown.
 */
async function disconnect() {
  if (prisma) {
    await prisma.$disconnect();
    console.log('Database disconnected');
    prisma = null;
  }
}

/**
 * Health check — run a simple query to verify the connection.
 * Returns { ok: true/false, latencyMs }
 */
async function healthCheck() {
  const start = Date.now();
  try {
    await getClient().$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Express middleware — attaches prisma to req.prisma
 * so all routes can access it via req.prisma.
 *
 * Usage in server.js:
 *   const { db } = require('./config');
 *   app.use(db.middleware());
 */
function middleware() {
  const client = getClient();
  return (req, res, next) => {
    req.prisma = client;
    next();
  };
}

module.exports = {
  get prisma() { return getClient(); },
  connect,
  disconnect,
  healthCheck,
  middleware,
};
