const { Client } = require('pg');
require('dotenv').config();
const db = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await db.connect();
  console.log('Fetching zip codes from psgc.cloud...');

  try {
    const citiesRes = await fetch('https://psgc.cloud/api/cities');
    const cities = await citiesRes.json();
    let updated = 0;

    for (const c of cities) {
      if (c.zip_code) {
        const r = await db.query(
          'UPDATE ph_cities_municipalities SET zip_code = $1 WHERE UPPER(name) = UPPER($2) AND zip_code IS NULL',
          [c.zip_code, c.name]
        );
        if (r.rowCount > 0) updated++;
      }
    }
    console.log('Cities: ' + updated + ' zip codes matched');

    const munRes = await fetch('https://psgc.cloud/api/municipalities');
    const muns = await munRes.json();
    let updated2 = 0;

    for (const m of muns) {
      if (m.zip_code) {
        const r = await db.query(
          'UPDATE ph_cities_municipalities SET zip_code = $1 WHERE UPPER(name) = UPPER($2) AND zip_code IS NULL',
          [m.zip_code, m.name]
        );
        if (r.rowCount > 0) updated2++;
      }
    }
    console.log('Municipalities: ' + updated2 + ' zip codes matched');

    const { rows } = await db.query('SELECT COUNT(*) as total, COUNT(zip_code) as with_zip FROM ph_cities_municipalities');
    console.log('\nResult: ' + rows[0].with_zip + '/' + rows[0].total + ' have zip codes');

    const { rows: sample } = await db.query('SELECT name, zip_code FROM ph_cities_municipalities WHERE zip_code IS NOT NULL ORDER BY name LIMIT 10');
    console.log('\nSample:');
    sample.forEach(r => console.log('  ' + r.name + ': ' + r.zip_code));

  } catch (err) {
    console.error('Error:', err.message);
  }
  await db.end();
}
main();
