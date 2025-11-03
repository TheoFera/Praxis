/************************************************************
 * server.js — API Express minimaliste pour servir les frontières
 * GET /api/frontieres?date=YYYY-MM-DD
 * Retourne un GeoJSON FeatureCollection
 ************************************************************/

// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const staticDir = path.join(__dirname, 'public');
console.log('Static dir =', staticDir);

const compression = require('compression');

// 1) Statique (sert ./public, index.html inclus)
app.use(express.static(staticDir, { index: 'index.html' }));

// 2) CORS (ok même si front et API sont sur la même origine)
app.use(cors());
app.use(compression());

// 3) PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// 4) Utilitaire
function isValidISODate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str);
  return !isNaN(d.getTime()) && str === d.toISOString().slice(0, 10);
}

// 5) API
app.get('/api/debug/dbinfo', async (req, res) => {
  const q = `
    SELECT current_database() AS db,
           current_user      AS usr,
           now()::date       AS today,
           MIN(f.date_fin)   AS min_fin,
           MAX(f.date_fin)   AS max_fin,
           COUNT(*)          AS nb_frontieres
    FROM frontiere f;
  `;
  const { rows } = await pool.query(q);
  res.json(rows[0]);
});


app.get('/api/frontieres', async (req, res) => {
  const client = await pool.connect();
  try {
    const dateStr = (req.query.date && isValidISODate(req.query.date))
      ? req.query.date : new Date().toISOString().slice(0,10);

    const types = (req.query.types ?? 'countries')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    const z = Math.max(0, Math.min(22, parseInt(req.query.zoom ?? '6', 10) || 6));

    // bbox "w,s,e,n"
    let bbox = null;
    if (req.query.bbox) {
      const p = String(req.query.bbox).split(',').map(Number);
      if (p.length === 4 && p.every(Number.isFinite)) bbox = p;
    }
    if (!bbox) {
      // fallback : toute la planète (reste OK grâce au plan de simplification)
      bbox = [-180,-85,180,85];
    }

    const sql = `
      WITH src AS (
        SELECT
          f.id, f.date_debut, f.date_fin,
          e.id   AS entity_id,
          e.name AS entity_name,
          LOWER(c.name) AS category_name,
          CASE
            WHEN $7 < 6  THEN f.geom_z0
            WHEN $7 < 8  THEN f.geom_z1
            ELSE               f.geom_z2
          END AS g
        FROM frontiere f
        JOIN parent_enfant_category pec ON pec.frontiere_id = f.id
        JOIN entity_category ec         ON ec.id = pec.ec_enfant_id
        JOIN entity e                   ON e.id = ec.entity_id
        JOIN category c                 ON c.id = ec.category_id
        WHERE (f.date_debut IS NULL OR f.date_debut <= $1::date)
          AND (f.date_fin   IS NULL OR f.date_fin   >= $1::date)
          AND LOWER(c.name) = ANY($2::text[])
          AND ST_Intersects(
                CASE WHEN $7 < 6 THEN f.geom_z0
                     WHEN $7 < 8 THEN f.geom_z1
                     ELSE              f.geom_z2
                END,
                ST_MakeEnvelope($3,$4,$5,$6,4326)
              )
      )
      SELECT jsonb_build_object(
        'type','FeatureCollection',
        'features', jsonb_agg(
           jsonb_build_object(
             'type','Feature',
             'id', id,
             'properties', jsonb_build_object(
                 'when', ARRAY[
                    CASE WHEN date_debut IS NULL THEN NULL ELSE to_char(date_debut,'YYYY-MM-DD') END,
                    CASE WHEN date_fin   IS NULL THEN NULL ELSE to_char(date_fin  ,'YYYY-MM-DD') END
                 ],
                 'entity_id', entity_id,
                 'entity_name', entity_name,
                 'category_name', category_name
             ),
             'geometry', (ST_AsGeoJSON(g, 6)::jsonb)
           )
        )
      ) AS fc
      FROM src;`;

    const { rows } = await client.query(sql, [
      dateStr, types, bbox[0], bbox[1], bbox[2], bbox[3], z
    ]);

    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify(rows[0].fc ?? {"type":"FeatureCollection","features":[]}));
  } catch (e) {
    console.error('ERR /api/frontieres', e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});


// 6) Catch-all (après l’API) → renvoie l’app front pour toute autre route GET
app.get('/', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// 7) Start
app.listen(PORT, () => {
  console.log(`API prête sur http://localhost:${PORT}`);
});