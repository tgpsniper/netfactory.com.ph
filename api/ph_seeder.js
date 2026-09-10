#!/usr/bin/env node
// ============================================================
// PSGC DATA SEEDER
// Fetches all Philippine regions, provinces, cities/municipalities,
// and barangays from the PSGC API and seeds into PostgreSQL.
// 
// Usage: node ph_seeder.js
// ============================================================

const { Client } = require('pg');

const API_BASE = 'https://psgc.gitlab.io/api';

// Database connection - reads from .env or use defaults
require('dotenv').config({ path: '/home/ubuntu/Node.js_API/j2-api/.env' });

const DB_URL = process.env.DATABASE_URL || 'postgresql://DBUSER:DBPASS@localhost:5432/DBNAME';

const db = new Client({ connectionString: DB_URL });

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function seedRegions() {
  console.log('\n📍 Fetching regions...');
  const regions = await fetchJSON(`${API_BASE}/regions/`);
  
  let sortOrder = 1;
  for (const r of regions) {
    await db.query(
      `INSERT INTO ph_regions (code, name, region_name, island_group, sort_order)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO UPDATE SET name=$2, region_name=$3, island_group=$4, sort_order=$5`,
      [r.code, r.name, r.regionName, r.islandGroupCode, sortOrder++]
    );
  }
  console.log(`   ✅ ${regions.length} regions`);
  return regions;
}

async function seedProvinces(regions) {
  console.log('\n📍 Fetching provinces...');
  let total = 0;

  for (const region of regions) {
    try {
      const provinces = await fetchJSON(`${API_BASE}/regions/${region.code}/provinces/`);
      for (const p of provinces) {
        await db.query(
          `INSERT INTO ph_provinces (code, name, region_code)
           VALUES ($1, $2, $3) ON CONFLICT (code) DO UPDATE SET name=$2, region_code=$3`,
          [p.code, p.name, region.code]
        );
        total++;
      }
      process.stdout.write(`   ${region.name}: ${provinces.length} provinces\n`);
    } catch (err) {
      // Some regions (NCR) may not have provinces, they have districts
      console.log(`   ${region.name}: checking districts...`);
      try {
        const districts = await fetchJSON(`${API_BASE}/regions/${region.code}/districts/`);
        for (const d of districts) {
          await db.query(
            `INSERT INTO ph_provinces (code, name, region_code)
             VALUES ($1, $2, $3) ON CONFLICT (code) DO UPDATE SET name=$2, region_code=$3`,
            [d.code, d.name, region.code]
          );
          total++;
        }
        console.log(`   ${region.name}: ${districts.length} districts`);
      } catch (e2) {
        console.log(`   ${region.name}: no provinces/districts found`);
      }
    }
    await sleep(200);
  }
  console.log(`   ✅ ${total} total provinces/districts`);
}

async function seedCitiesMunicipalities() {
  console.log('\n📍 Fetching cities & municipalities...');
  
  // Get all provinces from DB
  const { rows: provinces } = await db.query('SELECT code, name FROM ph_provinces ORDER BY name');
  let total = 0;

  for (const prov of provinces) {
    try {
      const items = await fetchJSON(`${API_BASE}/provinces/${prov.code}/cities-municipalities/`);
      for (const cm of items) {
        // Determine if it's a city based on PSGC code pattern or name
        const isCity = cm.name.toLowerCase().includes('city') || (cm.isCity === true);
        await db.query(
          `INSERT INTO ph_cities_municipalities (code, name, province_code, is_city)
           VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET name=$2, province_code=$3, is_city=$4`,
          [cm.code, cm.name, prov.code, isCity]
        );
        total++;
      }
      process.stdout.write(`   ${prov.name}: ${items.length} cities/municipalities\n`);
    } catch (err) {
      // For NCR districts, try cities endpoint
      try {
        const cities = await fetchJSON(`${API_BASE}/districts/${prov.code}/cities/`);
        for (const c of cities) {
          await db.query(
            `INSERT INTO ph_cities_municipalities (code, name, province_code, is_city)
             VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET name=$2, province_code=$3, is_city=$4`,
            [c.code, c.name, prov.code, true]
          );
          total++;
        }
        console.log(`   ${prov.name}: ${cities.length} cities`);
      } catch (e2) {
        // Try municipalities endpoint
        try {
          const muns = await fetchJSON(`${API_BASE}/districts/${prov.code}/municipalities/`);
          for (const m of muns) {
            await db.query(
              `INSERT INTO ph_cities_municipalities (code, name, province_code, is_city)
               VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET name=$2, province_code=$3, is_city=$4`,
              [m.code, m.name, prov.code, false]
            );
            total++;
          }
          console.log(`   ${prov.name}: ${muns.length} municipalities`);
        } catch (e3) {
          console.log(`   ⚠ ${prov.name}: no cities/municipalities found`);
        }
      }
    }
    await sleep(200);
  }
  console.log(`   ✅ ${total} total cities/municipalities`);
}

async function seedBarangays() {
  console.log('\n📍 Fetching barangays (this will take several minutes)...');
  
  const { rows: citymuns } = await db.query('SELECT code, name FROM ph_cities_municipalities ORDER BY name');
  let total = 0;
  let batchValues = [];
  let batchCount = 0;

  for (let i = 0; i < citymuns.length; i++) {
    const cm = citymuns[i];
    try {
      const brgys = await fetchJSON(`${API_BASE}/cities-municipalities/${cm.code}/barangays/`);
      
      for (const b of brgys) {
        batchValues.push(`('${b.code}', '${b.name.replace(/'/g, "''")}', '${cm.code}')`);
        batchCount++;
        
        // Bulk insert every 500 records
        if (batchValues.length >= 500) {
          await db.query(
            `INSERT INTO ph_barangays (code, name, city_mun_code) VALUES ${batchValues.join(',')}
             ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, city_mun_code=EXCLUDED.city_mun_code`
          );
          batchValues = [];
        }
      }
      total += brgys.length;
    } catch (err) {
      // Try sub-municipalities for Manila
      try {
        const subs = await fetchJSON(`${API_BASE}/cities-municipalities/${cm.code}/sub-municipalities/`);
        for (const sub of subs) {
          // Sub-municipalities are treated as barangays for our purposes
          batchValues.push(`('${sub.code}', '${sub.name.replace(/'/g, "''")}', '${cm.code}')`);
          batchCount++;
          total++;

          if (batchValues.length >= 500) {
            await db.query(
              `INSERT INTO ph_barangays (code, name, city_mun_code) VALUES ${batchValues.join(',')}
               ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, city_mun_code=EXCLUDED.city_mun_code`
            );
            batchValues = [];
          }
        }
      } catch(e2) {
        // silently skip
      }
    }
    
    // Progress
    if ((i + 1) % 50 === 0 || i === citymuns.length - 1) {
      process.stdout.write(`   Progress: ${i + 1}/${citymuns.length} cities/municipalities processed, ${total} barangays so far\r`);
    }
    
    // Throttle to avoid overwhelming the API
    if ((i + 1) % 10 === 0) await sleep(300);
  }

  // Flush remaining
  if (batchValues.length > 0) {
    await db.query(
      `INSERT INTO ph_barangays (code, name, city_mun_code) VALUES ${batchValues.join(',')}
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, city_mun_code=EXCLUDED.city_mun_code`
    );
  }

  console.log(`\n   ✅ ${total} total barangays`);
}

async function seedZipCodes() {
  console.log('\n📍 Fetching zip codes from psgc.cloud...');
  let updated = 0;
  
  try {
    // Fetch all cities-municipalities from psgc.cloud which includes zip_code
    const data = await fetchJSON('https://psgc.cloud/api/cities-municipalities');
    
    for (const cm of data) {
      if (cm.zip_code) {
        const result = await db.query(
          `UPDATE ph_cities_municipalities SET zip_code = $1 WHERE code = $2 AND zip_code IS NULL`,
          [cm.zip_code, cm.code]
        );
        if (result.rowCount > 0) updated++;
      }
    }
    console.log(`   ✅ ${updated} zip codes updated`);
  } catch (err) {
    console.log(`   ⚠ Could not fetch zip codes from psgc.cloud: ${err.message}`);
    console.log('   You can add zip codes manually later.');
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   PSGC DATA SEEDER — Philippine Address Data    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\nDatabase: ${DB_URL.replace(/:[^:@]+@/, ':***@')}`);

  try {
    await db.connect();
    console.log('✅ Database connected');

    const regions = await seedRegions();
    await seedProvinces(regions);
    await seedCitiesMunicipalities();
    await seedBarangays();
    await seedZipCodes();

    // Print summary
    const counts = {};
    for (const table of ['ph_regions', 'ph_provinces', 'ph_cities_municipalities', 'ph_barangays']) {
      const { rows } = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
      counts[table] = rows[0].count;
    }

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   SEEDING COMPLETE                               ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Regions:              ${String(counts.ph_regions).padEnd(26)}║`);
    console.log(`║  Provinces:            ${String(counts.ph_provinces).padEnd(26)}║`);
    console.log(`║  Cities/Municipalities: ${String(counts.ph_cities_municipalities).padEnd(25)}║`);
    console.log(`║  Barangays:            ${String(counts.ph_barangays).padEnd(26)}║`);
    console.log('╚══════════════════════════════════════════════════╝');

  } catch (err) {
    console.error('✗ Error:', err.message);
    console.error(err.stack);
  } finally {
    await db.end();
  }
}

main();
