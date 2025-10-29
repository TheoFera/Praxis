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
app.get('/api/frontieres', async (req, res) => {
  try {
    const dateStr = req.query.date;
    if (!dateStr || !isValidISODate(dateStr)) {
      return res.status(400).json({ error: "Paramètre 'date' requis au format YYYY-MM-DD" });
    }

    const sql = `
      SELECT id, geojson, date_debut, date_fin
      FROM frontiere
      WHERE (date_debut IS NULL OR date_debut <= $1::date)
        AND (date_fin   IS NULL OR date_fin   >= $1::date)
    `;
    const { rows } = await pool.query(sql, [dateStr]);

    const features = rows.map(r => {
      const g = r.geojson; // JSONB -> objet JS
      const feature = g && g.type === 'Feature'
        ? g
        : { type: 'Feature', properties: {}, geometry: g || null };

      if (feature && feature.geometry) {
        const start = r.date_debut ? new Date(r.date_debut).toISOString().slice(0, 10) : null;
        const end   = r.date_fin   ? new Date(r.date_fin).toISOString().slice(0, 10) : null;
        feature.geometry.when = [start, end];
      }
      feature.id = r.id;
      return feature;
    });

    res.json({ type: 'FeatureCollection', features });
  } catch (e) {
    console.error('Erreur /api/frontieres :', e);
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