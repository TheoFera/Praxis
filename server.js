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



// 1) Statique (sert ./public, index.html inclus)
app.use(express.static(staticDir, { index: 'index.html' }));

// 2) CORS (ok même si front et API sont sur la même origine)
app.use(cors());

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
  try {
    const dateStr = req.query.date;
    if (!dateStr || !isValidISODate(dateStr)) {
      return res.status(400).json({ error: "Paramètre 'date' requis au format YYYY-MM-DD" });
    }

    const sql = `
      SELECT
        f.id,
        f.geojson,
        f.date_debut,
        f.date_fin,
        e.id   AS entity_id,
        e.name AS entity_name,
        c.id   AS category_id,
        c.name AS category_name
      FROM frontiere f
      INNER JOIN parent_enfant_category pec ON pec.frontiere_id = f.id
      INNER JOIN entity_category ec         ON ec.id = pec.ec_enfant_id
      INNER JOIN entity e                   ON e.id = ec.entity_id
      INNER JOIN category c                 ON c.id = ec.category_id
      WHERE (f.date_debut IS NULL OR f.date_debut <= $1::date)
        AND (f.date_fin   IS NULL OR f.date_fin   >= $1::date);
    `;

    const { rows } = await pool.query(sql, [dateStr]);

    const features = rows.map(r => {
      const g = r.geojson && r.geojson.type === 'Feature'
        ? r.geojson
        : { type: 'Feature', properties: {}, geometry: r.geojson || null };

      if (g && g.geometry) {
        const start = r.date_debut ? new Date(r.date_debut).toISOString().slice(0, 10) : null;
        const end   = r.date_fin   ? new Date(r.date_fin).toISOString().slice(0, 10) : null;
        g.geometry.when = [start, end];
      }

      g.properties = g.properties || {};
      if ('name' in g.properties) delete g.properties.name;

      g.properties.entity_id      = r.entity_id      ?? null;
      g.properties.entity_name    = r.entity_name    ?? null;
      g.properties.category_id    = r.category_id    ?? null;
      g.properties.category_name  = r.category_name  ?? null;

      g.id = r.id;
      return g;
    });

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
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