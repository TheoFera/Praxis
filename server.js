/************************************************************
 * server.js
 * - Sert les fichiers statiques (index.html, script.js, etc.)
 * - API /api/frontieres : renvoie un GeoJSON FeatureCollection
 * - API /api/editor/apply : traite pour l’instant l’opération "edit-dates"
 ************************************************************/

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const { Pool }    = require('pg');
const path        = require('path');

const app  = express();
const PORT = process.env.PORT || 4000;

// 1) Middlewares
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '5mb' }));

// 2) Fichiers statiques (index.html, script.js, style.css…)
const staticDir = path.join(__dirname, 'public');
app.use(express.static(staticDir));

// 3) Connexion PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// 4) Petit helper pour vérifier une date YYYY-MM-DD
function isValidISODate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

// Constantes par défaut pour éviter les valeurs magiques dans le code
const DEFAULT_BBOX = [-180, -90, 180, 90];
const DEFAULT_TYPES = ['countries'];

// Calcule la date du jour au format YYYY-MM-DD (utilisée comme valeur de repli)
const todayISO = () => new Date().toISOString().slice(0, 10);

// Convertit "countries,districts" -> ['countries','districts'] en éliminant le bruit
function parseTypeList(rawTypes = '') {
  return (rawTypes || DEFAULT_TYPES.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Convertit "w,s,e,n" -> [w,s,e,n] ou renvoie la bbox par défaut si invalide
function parseBBox(raw) {
  if (!raw) return DEFAULT_BBOX;
  const parts = raw.split(',').map(Number);
  if (parts.length === 4 && parts.every((v) => !Number.isNaN(v))) return parts;
  return DEFAULT_BBOX;
}

// Normalise une liste d'identifiants (supprime le bruit et garde uniquement les entiers)
function normalizeIdList(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isInteger);
}

// Vêrifie que start <= end et que les dates sont au format ISO
function validateDateRange(startStr, endStr) {
  const errors = [];
  if (!startStr || !isValidISODate(startStr)) errors.push('Date de début invalide ou manquante.');
  if (!endStr || !isValidISODate(endStr)) errors.push('Date de fin invalide ou manquante.');
  if (startStr && endStr && isValidISODate(startStr) && isValidISODate(endStr)) {
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (start.getTime() > end.getTime()) errors.push('La date de début doit être <= la date de fin.');
  }
  return errors;
}

/************************************************************
 * GET /api/frontieres
 * Query :
 *   - date=YYYY-MM-DD
 *   - types=countries,districts,municipalities   (catégories)
 *   - zoom=nombre (entier)
 *   - bbox=west,south,east,north   (en WGS84)
 *
 * Retourne un GeoJSON FeatureCollection
 * Chaque feature a dans properties :
 *   - frontiere_id
 *   - when = [date_debut, date_fin]
 *   - entity_id, entity_name
 *   - entity_category_id
 *   - category_name
 ************************************************************/
/************************************************************
 * GET /api/frontieres
 ************************************************************/
app.get('/api/frontieres', async (req, res) => {
  // Connexion manuelle pour pouvoir libérer proprement le client en fin de requéte
  const client = await pool.connect();
  try {
    // Paramétres d'entrée avec valeurs de repli
    const dateStr = isValidISODate(req.query.date) ? req.query.date : todayISO(); // date cible
    const types   = parseTypeList(req.query.types);                               // categories demandées
    const z       = Number(req.query.zoom) || 5;                                  // niveau de zoom courant
    const bbox    = parseBBox(req.query.bbox);                                    // fenétre visible

    // Requéte SQL : on fait tout le formatage GeoJSON côté PostgreSQL pour limiter le post-traitement
    // MODIFICATION : On joint pour trouver le nom du parent (e_p.name)
    const sql = `
      WITH src AS (
        SELECT
          f.id         AS frontiere_id,
          f.date_debut,
          f.date_fin,
          e.id         AS entity_id,
          e.name       AS entity_name,
          ec.id        AS entity_category_id,
          LOWER(c.name) AS category_name,
          e_p.name     AS parent_name,       -- <--- NOUVEAU
          CASE
            WHEN $7 < 4  THEN f.geom_z2
            WHEN $7 < 7  THEN f.geom_z1
            ELSE COALESCE(f.geom_z0, f.geom)
          END AS g,
          ROW_NUMBER() OVER (
            PARTITION BY f.id
            ORDER BY (pec.ec_parent_id IS NULL) DESC, pec.id
          ) AS rn
        FROM frontiere f
        JOIN parent_enfant_category pec ON pec.frontiere_id = f.id
        JOIN entity_category ec         ON ec.id = pec.ec_enfant_id
        JOIN entity e                   ON e.id = ec.entity_id
        JOIN category c                 ON c.id = ec.category_id
        -- Jointure pour le parent actuel
        LEFT JOIN entity_category ec_p  ON ec_p.id = pec.ec_parent_id
        LEFT JOIN entity e_p            ON e_p.id = ec_p.entity_id
        
        WHERE (f.date_debut IS NULL OR f.date_debut <= $1::date)
          AND (f.date_fin   IS NULL OR f.date_fin   >= $1::date)
          AND LOWER(c.name) = ANY($2::text[])
          AND ST_Intersects(
                CASE WHEN $7 < 4  THEN f.geom_z2
                     WHEN $7 < 7 THEN f.geom_z1
                     ELSE COALESCE(f.geom_z0, f.geom)  
                END,
                ST_MakeEnvelope($3,$4,$5,$6,4326)
              )
      )
      , filtered AS (
        SELECT * FROM src WHERE rn = 1
      )
      SELECT jsonb_build_object(
        'type','FeatureCollection',
        'features', COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'type','Feature',
               'id', frontiere_id,
               'properties', jsonb_build_object(
                   'frontiere_id', frontiere_id,
                   'when', ARRAY[
                      CASE WHEN date_debut IS NULL THEN NULL ELSE to_char(date_debut,'YYYY-MM-DD') END,
                      CASE WHEN date_fin   IS NULL THEN NULL ELSE to_char(date_fin  ,'YYYY-MM-DD') END
                   ],
                   'entity_id',          entity_id,
                   'entity_name',        entity_name,
                   'entity_category_id', entity_category_id,
                   'category_name',      category_name,
                   'parent_name',        parent_name   -- <--- NOUVEAU
               ),
               'geometry', (ST_AsGeoJSON(g, 6)::jsonb)
             )
           ),
           '[]'::jsonb
        )
      ) AS fc
      FROM filtered; 
    `; 

    const { rows } = await client.query(sql, [
      dateStr,             // $1 : date de référence
      types,               // $2 : liste de catégories
      bbox[0], bbox[1],    // $3 / $4 : bornes Ouest / Sud
      bbox[2], bbox[3],    // $5 / $6 : bornes Est / Nord
      z                    // $7 : niveau de zoom (choix du niveau de simplification)
    ]);

    // Récupération sécurisée du résultat (GeoJSON produit par le SQL)
    const fc = rows[0]?.fc || { type: 'FeatureCollection', features: [] };
    res.json(fc);
  } catch (err) {
    console.error('Erreur /api/frontieres :', err);
    res.status(500).json({ error: 'Erreur serveur /api/frontieres' });
  } finally {
    client.release();
  }
});


/**
 * Recalcule la géométrie de la frontière mère à partir de ses enfants.
 *
 * - client       : client PG déjà dans une transaction
 * - frontId      : id de la ligne "frontiere" de la MÈRE à mettre à jour
 * - ecParentId   : id de l'entity_category parent
 * - startStr/endStr : période sur laquelle on considère les enfants (peut être null)
 */

/**
 * Recalcule la géométrie de la frontière mère à partir de ses enfants.
 * Cette version cherche la géométrie ACTIVE des enfants sur la période donnée.
 */
async function recomputeParentGeometry(client, frontId, ecParentId, startStr, endStr) {
  
  // 1. Sécurité : Si les dates sont nulles (ex: edit-borders simple), 
  // on récupère les dates actuelles de la frontière parente pour savoir quelle version des enfants choisir.
  if (!startStr || !endStr) {
    const resDates = await client.query('SELECT date_debut, date_fin FROM frontiere WHERE id = $1', [frontId]);
    if (resDates.rows.length > 0) {
      if (!startStr) startStr = resDates.rows[0].date_debut; // Peut rester null si infini
      if (!endStr)   endStr   = resDates.rows[0].date_fin;
    }
  }

  /* 
     EXPLICATION DU SQL CI-DESSOUS (Lecture pédagogique) :
     
     CTE 'mes_enfants_ids' : 
       - On liste les ID de catégorie des enfants directement rattachés à NOTRE frontière mère (frontId).
       Ex: Pour France 1700, on trouve l'ID de la catégorie "Bourgogne".

     CTE 'geometries_des_enfants' :
       - C'est l'étape cruciale. Pour chaque enfant (Bourgogne), on doit trouver SA frontière active.
       - On cherche dans parent_enfant_category (pec) les lignes où le PARENT est la Bourgogne (ec_parent_id).
       - Pourquoi ? Parce qu'une entité est définie par les frontières qu'elle "possède" en tant que parent.
       - On joint la table 'frontiere' (f_child) pour récupérer la géométrie.
       - FILTRE TEMPOREL : On ne garde que les frontières de la Bourgogne qui existent PENDANT la période de la France.
         (Chevauchement de dates : début_enfant <= fin_parent ET fin_enfant >= début_parent).

     CTE 'agg' :
       - On fait l'Union (ST_Union) de toutes les géométries trouvées.
  */

  const sql = `
    WITH mes_enfants_ids AS (
      SELECT ec_enfant_id 
      FROM parent_enfant_category 
      WHERE frontiere_id = $1
    ),
    geometries_des_enfants AS (
      SELECT f_child.geom
      FROM parent_enfant_category pec_definition
      -- On cherche la frontière qui DÉFINIT l'enfant. 
      -- Dans ton modèle, une frontière appartient à l'entité listée en 'ec_parent_id'.
      JOIN frontiere f_child ON f_child.id = pec_definition.frontiere_id
      WHERE pec_definition.ec_parent_id IN (SELECT ec_enfant_id FROM mes_enfants_ids)
      
      -- Logique temporelle stricte pour éviter de prendre la Bourgogne de 2024 pour la France de 1700
      AND (
        ($2::date IS NULL OR f_child.date_fin IS NULL   OR f_child.date_fin >= $2::date)
        AND
        ($3::date IS NULL OR f_child.date_debut IS NULL OR f_child.date_debut <= $3::date)
      )
    ),
    agg AS (
      SELECT ST_Union(geom) AS g
      FROM geometries_des_enfants
    )
    UPDATE frontiere f
    SET
      -- On met à jour la géométrie principale (Ultra Haute Résolution)
      geom    = agg.g,
      
      -- IMPORTANT : On force geom_z0 à NULL ou on le met à jour. 
      -- Si ton API 'GET' utilise COALESCE(geom_z0, geom), mettre NULL force l'utilisation de geom (HD).
      geom_z0 = NULL,

      -- On recalcule les simplifications pour les zooms éloignés (performance)
      geom_z1 = ST_SimplifyPreserveTopology(agg.g, 0.01), -- Zoom moyen
      geom_z2 = ST_SimplifyPreserveTopology(agg.g, 0.1),  -- Zoom loin

      -- Mise à jour du GeoJSON texte si tu l'utilises ailleurs
      geojson = ST_AsGeoJSON(agg.g, 6)::jsonb
    FROM agg
    WHERE f.id = $1
      AND agg.g IS NOT NULL -- Sécurité : on ne met à jour que si l'union a fonctionné (au moins 1 enfant trouvé)
    RETURNING f.id, f.date_debut, f.date_fin;
  `;

  try {
    const { rows } = await client.query(sql, [
      frontId,          // $1
      startStr || null, // $2
      endStr   || null  // $3
    ]);
    
    if (rows.length === 0) {
      console.log("⚠️ Aucune géométrie recalculée (peut-être aucun enfant trouvé ou pas de géométrie correspondante aux dates).");
    } else {
      console.log(`✅ Frontière ${frontId} mise à jour avec succès (Union géométrique).`);
    }

    return rows[0] || null;

  } catch (err) {
    console.error("Erreur SQL dans recomputeParentGeometry:", err);
    throw err; // On relance l'erreur pour annuler la transaction
  }
}


async function insertFrontiereFromGeometry(client, geomObj, startStr, endStr) {
  // Crée une frontière à partir d'un GeoJSON (geom) et renvoie la ligne insérée.
  if (!geomObj) throw new Error('Geometry manquante pour la création de la frontière.');

  const geomJSON = (typeof geomObj === 'string') ? geomObj : JSON.stringify(geomObj);
  const sql = `
    WITH g AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
    )
    INSERT INTO frontiere(geom, geom_z0, geom_z1, geom_z2, geojson, date_debut, date_fin)
    SELECT
      g.geom,
      NULL,
      ST_SimplifyPreserveTopology(g.geom, 0.01),
      ST_SimplifyPreserveTopology(g.geom, 0.1),
      ST_AsGeoJSON(g.geom, 6)::jsonb,
      $2::date,
      $3::date
    FROM g
    RETURNING id, date_debut, date_fin;
  `;

  const { rows } = await client.query(sql, [geomJSON, startStr || null, endStr || null]);
  return rows[0];
}

// Duplique une frontière en conservant sa géométrie et en assignant de nouvelles dates.
async function duplicateFrontiereWithDates(client, sourceFrontId, startStr, endStr) {
  const sql = `
    INSERT INTO frontiere(geom, geom_z0, geom_z1, geom_z2, geojson, date_debut, date_fin)
    SELECT geom, geom_z0, geom_z1, geom_z2, geojson, $2::date, $3::date
    FROM frontiere
    WHERE id = $1
    RETURNING id, date_debut, date_fin;
  `;
  const { rows } = await client.query(sql, [sourceFrontId, startStr, endStr]);
  return rows[0];
}

/************************************************************
 * POST /api/editor/apply
 * Corps JSON (simplifié) :
 *  {
 *    operation: "edit-dates" | "edit-borders",
 *    parent: {
 *      frontiereId: number,
 *      entityCategoryId: number,
 *      ...
 *    },
 *    period: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *    selections: {
 *      add:    [ec_enfant_id, ...],
 *      remove: [ec_enfant_id, ...]
 *    }
 *  }
 ************************************************************/

app.post('/api/editor/apply', async (req, res) => {
  const body = req.body || {};
  const op   = body.operation; // type d'opération demandée (edit-dates, edit-borders, ...)

  if (!op) {
    return res.status(400).json({
      ok: false,
      error: 'Champ "operation" manquant dans le payload.'
    });
  }

  /***********************
   * 1) EDIT-DATES
   ***********************/
  if (op === 'edit-dates') {
    const parent   = body.parent || {};
    const period   = body.period || {};
    const frontId  = parent.frontiereId;

    const startStr = period.start;
    const endStr   = period.end;

    const problems = validateDateRange(startStr, endStr);
    if (!frontId) problems.unshift('frontiereId manquant dans le payload.');

    // Validation avant d'ouvrir une transaction
    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: problems.join(' ') });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // transaction pour garantir la coherence

      const updateSQL = `
        UPDATE frontiere
        SET date_debut = $1::date,
            date_fin   = $2::date
        WHERE id = $3
        RETURNING id, date_debut, date_fin;
      `;
      const { rows } = await client.query(updateSQL, [startStr, endStr, frontId]);

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          ok: false,
          error: `Aucune frontière trouvée avec id=${frontId}.`
        });
      }

      await client.query('COMMIT');

      return res.json({
        ok: true,
        result: {
          updatedFrontiere: rows[0]
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erreur /api/editor/apply (edit-dates) :', err);
      return res.status(500).json({
        ok: false,
        error: 'Erreur serveur lors de la mise à jour des dates.'
      });
    } finally {
      client.release();
    }
  }

  /***********************
   * 2) EDIT-BORDERS (cas simple)
   *    - on modifie les liens parent/enfant (table parent_enfant_category)
   *    - pour une frontière donnée (frontiere_id)
   *    - sans découper les périodes
   ***********************/
  if (op === 'edit-borders') {
    const parent     = body.parent || {};
    const period     = body.period || {};
    const selections = body.selections || {};

    const frontId    = parent.frontiereId;
    const ecParentId = parent.entityCategoryId;

    const addList    = normalizeIdList(selections.add);    // enfants à ajouter
    const removeList = normalizeIdList(selections.remove); // enfants à retirer

    // Periode (optionnelle) a utiliser comme filtre dans recomputeParentGeometry
    let startStr = period.start || null;
    let endStr   = period.end   || null;
    if (startStr && !isValidISODate(startStr)) startStr = null;
    if (endStr   && !isValidISODate(endStr))   endStr   = null;

    const problems = [];
    if (!frontId) {
      problems.push('frontiereId manquant pour edit-borders.');
    }
    if (!ecParentId) {
      problems.push('entityCategoryId (parent) manquant pour edit-borders.');
    }
    if (addList.length === 0 && removeList.length === 0) {
      problems.push('Aucune modification d’enfants (add/remove) demandée.');
    }

    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: problems.join(' ') });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // debut de transaction

      // 1) Vérifier que la frontière existe
      const checkFront = await client.query(
        'SELECT id, date_debut, date_fin FROM frontiere WHERE id = $1',
        [frontId]
      );
      if (checkFront.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          ok: false,
          error: `Aucune frontière trouvée avec id=${frontId}.`
        });
      }

      // 2) Vérifier que le parent entity_category existe
      const checkParent = await client.query(
        'SELECT id FROM entity_category WHERE id = $1',
        [ecParentId]
      );
      if (checkParent.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          ok: false,
          error: `Aucun entity_category (parent) trouvé avec id=${ecParentId}.`
        });
      }

      let addedCount   = 0;
      let removedCount = 0;

      // 3) Ajouts
      for (const childId of addList) {
        const insertSQL = `
          INSERT INTO parent_enfant_category (ec_parent_id, ec_enfant_id, frontiere_id)
          SELECT $1, $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM parent_enfant_category
            WHERE ec_parent_id = $1
              AND ec_enfant_id = $2
              AND frontiere_id = $3
          );
        `;
        const r = await client.query(insertSQL, [ecParentId, childId, frontId]);
        addedCount += r.rowCount;
      }

      // 4) Suppressions
      for (const childId of removeList) {
        const deleteSQL = `
          DELETE FROM parent_enfant_category
          WHERE ec_parent_id = $1
            AND ec_enfant_id = $2
            AND frontiere_id = $3;
        `;
        const r = await client.query(deleteSQL, [ecParentId, childId, frontId]);
        removedCount += r.rowCount;
      }

      // 5) Recalcul de la géométrie du parent à partir des enfants
      const recomputed = await recomputeParentGeometry(
        client,
        frontId,     // L'ID de la frontière mère qu'on modifie
        ecParentId,  // L'ID Category du parent (moins utile avec le nouveau SQL mais gardons la signature)
        startStr,    // Date début (peut être null)
        endStr       // Date fin (peut être null)
      );

      await client.query('COMMIT');

      return res.json({
        ok: true,
        result: {
          operation:   'edit-borders',
          frontiereId: frontId,
          ecParentId:  ecParentId,
          added:       addedCount,
          removed:     removedCount,
          recomputedFrontiere: recomputed   // peut être null si aucun enfant
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erreur /api/editor/apply (edit-borders) :', err);
      return res.status(500).json({
        ok: false,
        error: 'Erreur serveur lors de la mise à jour des enfants (edit-borders).'
      });
    } finally {
      client.release();
    }
  }



    /***********************
   * 3) EDIT-BORDERS-DATES
   *    - on met à jour les dates de la frontière
   *    - puis on met à jour les liens parent/enfant
   *    - tout ça dans UNE SEULE transaction
   ***********************/
  if (op === 'create-entity') {
    const parent     = body.parent || {};
    const period     = body.period || {};
    const selections = body.selections || {};
    const newEntity  = body.newEntity || {};

    const parentFrontiereId = Number(parent.frontiereId) || null;
    const parentEcId        = Number(parent.entityCategoryId) || null;

    const startStr = period.start;
    const endStr   = period.end;

    const addList    = normalizeIdList(selections.add);
    const removeList = normalizeIdList(selections.remove);

    const name     = (newEntity.name || '').trim();
    const category = (newEntity.category || '').trim().toLowerCase();
    const geometry = body.geometry || body.newGeometry || null;

    const problems = validateDateRange(startStr, endStr);
    if (!name) problems.unshift('Nom de la nouvelle entite manquant.');
    if (!category) problems.unshift('Categorie de la nouvelle entite manquante.');
    const hasParent = Boolean(parentEcId) && Boolean(parentFrontiereId);
    const partialParent = (!parentEcId && parentFrontiereId) || (parentEcId && !parentFrontiereId);
    if (partialParent) problems.unshift('Si un parent est fourni, frontiereId et entityCategoryId doivent etre renseignes tous les deux.');
    if (!geometry) problems.push('Aucune geometrie fournie pour la nouvelle entite (lance la previsualisation).');

    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: problems.join(' ') });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (hasParent) {
        const parentFront = await client.query(
          'SELECT id FROM frontiere WHERE id = $1',
          [parentFrontiereId]
        );
        if (parentFront.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ ok: false, error: `Frontiere parente ${parentFrontiereId} introuvable.` });
        }

        const parentEcRow = await client.query(
          'SELECT id FROM entity_category WHERE id = $1',
          [parentEcId]
        );
        if (parentEcRow.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ ok: false, error: `Entity_category parent ${parentEcId} introuvable.` });
        }
      }

      const catRes = await client.query(
        'SELECT id FROM category WHERE LOWER(name) = LOWER($1) LIMIT 1',
        [category]
      );
      if (catRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: `Categorie "${category}" inconnue.` });
      }
      const categoryId = catRes.rows[0].id;

      const entRes = await client.query(
        'INSERT INTO entity(name) VALUES ($1) RETURNING id',
        [name]
      );
      const entityId = entRes.rows[0].id;

      const ecRes = await client.query(
        'INSERT INTO entity_category(entity_id, category_id) VALUES ($1, $2) RETURNING id',
        [entityId, categoryId]
      );
      const newEcId = ecRes.rows[0].id;

      const newFrontiere = await insertFrontiereFromGeometry(client, geometry, startStr, endStr);
      if (!newFrontiere) throw new Error('Creation de la frontiere echouee.');
      const newFrontiereId = newFrontiere.id;

      if (hasParent) {
        await client.query(
          `INSERT INTO parent_enfant_category(ec_parent_id, ec_enfant_id, frontiere_id)
           SELECT $1, $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM parent_enfant_category
             WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3
           )`,
          [parentEcId, newEcId, newFrontiereId]
        );

        await client.query(
          `INSERT INTO parent_enfant_category(ec_parent_id, ec_enfant_id, frontiere_id)
           SELECT $1, $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM parent_enfant_category
             WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3
           )`,
          [parentEcId, newEcId, parentFrontiereId]
        );
      } else {
        // Parent optionnel : ligne avec parent NULL pour rendre la frontiere consultable
        await client.query(
          `INSERT INTO parent_enfant_category(ec_parent_id, ec_enfant_id, frontiere_id)
           SELECT NULL, $1, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM parent_enfant_category
             WHERE ec_parent_id IS NULL AND ec_enfant_id = $1 AND frontiere_id = $2
           )`,
          [newEcId, newFrontiereId]
        );
      }

      let addedCount = 0;
      let removedCount = 0;
      for (const childId of addList) {
        const r = await client.query(
          `INSERT INTO parent_enfant_category(ec_parent_id, ec_enfant_id, frontiere_id)
           SELECT $1, $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM parent_enfant_category
             WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3
           )`,
          [newEcId, childId, newFrontiereId]
        );
        addedCount += r.rowCount;
      }
      for (const childId of removeList) {
        const r = await client.query(
          `DELETE FROM parent_enfant_category
           WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3`,
          [newEcId, childId, newFrontiereId]
        );
        removedCount += r.rowCount;
      }

      if (hasParent) {
        await recomputeParentGeometry(client, parentFrontiereId, parentEcId, startStr, endStr);
      }

      await client.query('COMMIT');
      return res.json({
        ok: true,
        result: {
          operation: 'create-entity',
          entityId,
          entityCategoryId: newEcId,
          frontiereId: newFrontiereId,
          addedChildren: addedCount,
          removedChildren: removedCount
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erreur /api/editor/apply (create-entity) :', err);
      return res.status(500).json({ ok: false, error: 'Erreur serveur lors de la creation de la nouvelle entite.' });
    } finally {
      client.release();
    }
  }

  /***********************
   * 3) EDIT-BORDERS-SPLIT
   *    - Segmente la frontière du parent sur [start,end]
   *    - Applique add/remove sur le segment
   *    - Recalcule la géométrie du parent
   *    - Pour chaque enfant ajouté, segmente les autres parents possédant cet enfant et retire l'enfant sur le segment
   ***********************/
  if (op === 'edit-borders-split') {
    const parent     = body.parent || {};
    const period     = body.period || {};
    const selections = body.selections || {};

    const frontId    = parent.frontiereId;
    const ecParentId = parent.entityCategoryId;

    const startStr = period.start;
    const endStr   = period.end;

    const addList    = normalizeIdList(selections.add);
    const removeList = normalizeIdList(selections.remove);

    const problems = [];
    if (!frontId)    problems.push('frontiereId manquant pour edit-borders-split.');
    if (!ecParentId) problems.push('entityCategoryId (parent) manquant pour edit-borders-split.');
    if (!startStr || !isValidISODate(startStr)) problems.push('Date de début invalide ou manquante.');
    if (!endStr   || !isValidISODate(endStr))   problems.push('Date de fin invalide ou manquante.');
    if (startStr && endStr && isValidISODate(startStr) && isValidISODate(endStr)) {
      const d1 = new Date(startStr);
      const d2 = new Date(endStr);
      if (d1.getTime() > d2.getTime()) problems.push('La date de début doit être <= à la date de fin.');
    }
    if (addList.length === 0 && removeList.length === 0) {
      problems.push('Aucune modification d’enfants (add/remove) demandée.');
    }

    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: problems.join(' ') });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // debut de transaction

      // Vérifier la frontière source
      const { rows: srcRows } = await client.query(
        'SELECT id, date_debut, date_fin FROM frontiere WHERE id = $1',
        [frontId]
      );
      if (srcRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: `Frontière ${frontId} introuvable.` });
      }
      const src = srcRows[0];
      const srcStart = src.date_debut;
      const srcEnd   = src.date_fin;

      // Segmenter la frontière parente
      let midFrontId = frontId;

      // Si le segment commence après le début, on réduit la frontière d'origine et on crée le segment milieu
      if (srcStart && startStr && new Date(srcStart) < new Date(startStr)) {
        await client.query(
          'UPDATE frontiere SET date_fin = $1::date WHERE id = $2',
          [startStr, frontId]
        );
        const mid = await duplicateFrontiereWithDates(client, frontId, startStr, srcEnd);
        midFrontId = mid.id;
      } else {
        // Sinon on s'assure que la frontière parent couvre le segment
        await client.query(
          'UPDATE frontiere SET date_debut = $1::date, date_fin = $2::date WHERE id = $3',
          [startStr, srcEnd, frontId]
        );
      }

      // Segment après si besoin
      if (srcEnd && endStr && new Date(srcEnd) > new Date(endStr)) {
        await duplicateFrontiereWithDates(client, midFrontId, endStr, srcEnd);
        await client.query(
          'UPDATE frontiere SET date_fin = $1::date WHERE id = $2',
          [endStr, midFrontId]
        );
      }

      // Appliquer add/remove sur le segment milieu
      let addedCount = 0;
      let removedCount = 0;
      for (const childId of addList) {
        const r = await client.query(
          `INSERT INTO parent_enfant_category (ec_parent_id, ec_enfant_id, frontiere_id)
           SELECT $1, $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM parent_enfant_category
             WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3
           )`,
          [ecParentId, childId, midFrontId]
        );
        addedCount += r.rowCount;
      }
      for (const childId of removeList) {
        const r = await client.query(
          `DELETE FROM parent_enfant_category
           WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3`,
          [ecParentId, childId, midFrontId]
        );
        removedCount += r.rowCount;
      }

      const recomputed = await recomputeParentGeometry(client, midFrontId, ecParentId, startStr, endStr);

      // Pour chaque enfant ajouté : retirer cet enfant des autres parents actifs sur le segment
      for (const childId of addList) {
        const { rows: otherLinks } = await client.query(
          `SELECT pec.frontiere_id, pec.ec_parent_id, f.date_debut, f.date_fin
           FROM parent_enfant_category pec
           JOIN frontiere f ON f.id = pec.frontiere_id
           WHERE pec.ec_enfant_id = $1
             AND pec.frontiere_id <> $2
             AND (f.date_debut IS NULL OR f.date_debut < $3::date)
             AND (f.date_fin   IS NULL OR f.date_fin   > $4::date)`,
          [childId, midFrontId, endStr, startStr]
        );

        for (const link of otherLinks) {
          const otherId = link.frontiere_id;
          const otherStart = link.date_debut;
          const otherEnd   = link.date_fin;

          // Segmenter l'autre frontière sur l'intervalle d'overlap
          let overlapStart = startStr;
          let overlapEnd   = endStr;
          if (otherStart && new Date(otherStart) > new Date(overlapStart)) overlapStart = otherStart.toISOString().slice(0,10);
          if (otherEnd   && new Date(otherEnd)   < new Date(overlapEnd))   overlapEnd   = otherEnd.toISOString().slice(0,10);

          let midOtherId = otherId;
          if (otherStart && new Date(otherStart) < new Date(overlapStart)) {
            await client.query('UPDATE frontiere SET date_fin = $1::date WHERE id = $2', [overlapStart, otherId]);
            const mid = await duplicateFrontiereWithDates(client, otherId, overlapStart, otherEnd);
            midOtherId = mid.id;
          } else {
            await client.query('UPDATE frontiere SET date_debut = $1::date WHERE id = $2', [overlapStart, otherId]);
          }
          if (otherEnd && new Date(otherEnd) > new Date(overlapEnd)) {
            await duplicateFrontiereWithDates(client, midOtherId, overlapEnd, otherEnd);
            await client.query('UPDATE frontiere SET date_fin = $1::date WHERE id = $2', [overlapEnd, midOtherId]);
          }

          // Retirer l'enfant sur le segment
          await client.query(
            `DELETE FROM parent_enfant_category
             WHERE ec_enfant_id = $1 AND frontiere_id = $2`,
            [childId, midOtherId]
          );
          await recomputeParentGeometry(client, midOtherId, link.ec_parent_id, overlapStart, overlapEnd);

          // Supprimer la frontière si elle n'a plus d'enfants
          const { rows: cntRows } = await client.query(
            `SELECT COUNT(*) AS c FROM parent_enfant_category WHERE frontiere_id = $1`,
            [midOtherId]
          );
          if (Number(cntRows[0].c) === 0) {
            await client.query('DELETE FROM frontiere WHERE id = $1', [midOtherId]);
          }
        }
      }

      await client.query('COMMIT');
      return res.json({
        ok: true,
        result: {
          operation: 'edit-borders-split',
          frontiereId: frontId,
          midFrontiereId: midFrontId,
          added: addedCount,
          removed: removedCount,
          recomputedFrontiere: recomputed
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erreur /api/editor/apply (edit-borders-split) :', err);
      return res.status(500).json({ ok: false, error: 'Erreur serveur lors de la segmentation des frontières.' });
    } finally {
      client.release();
    }
  }

  if (op === 'edit-borders-dates') {
    const parent     = body.parent || {};
    const period     = body.period || {};
    const selections = body.selections || {};

    const frontId    = parent.frontiereId;
    const ecParentId = parent.entityCategoryId;

    const startStr = period.start;
    const endStr   = period.end;

    const addList    = normalizeIdList(selections.add);
    const removeList = normalizeIdList(selections.remove);

    const problems = [];

    if (!frontId) {
      problems.push('frontiereId manquant pour edit-borders-dates.');
    }
    if (!ecParentId) {
      problems.push('entityCategoryId (parent) manquant pour edit-borders-dates.');
    }
    if (!startStr || !isValidISODate(startStr)) {
      problems.push('Date de début invalide ou manquante.');
    }
    if (!endStr || !isValidISODate(endStr)) {
      problems.push('Date de fin invalide ou manquante.');
    }
    if (startStr && endStr && isValidISODate(startStr) && isValidISODate(endStr)) {
      const d1 = new Date(startStr);
      const d2 = new Date(endStr);
      if (d1.getTime() > d2.getTime()) {
        problems.push('La date de début doit être ≤ la date de fin.');
      }
    }
    if (addList.length === 0 && removeList.length === 0) {
      problems.push('Aucune modification d’enfants (add/remove) demandée pour edit-borders-dates.');
    }

    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: problems.join(' ') });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // debut de transaction

      // 1) Mettre à jour les dates de la frontière
      const updateDatesSQL = `
        UPDATE frontiere
        SET date_debut = $1::date,
            date_fin   = $2::date
        WHERE id = $3
        RETURNING id, date_debut, date_fin;
      `;
      const { rows: rowsFront } = await client.query(updateDatesSQL, [startStr, endStr, frontId]);
      if (rowsFront.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          ok: false,
          error: `Aucune frontière trouvée avec id=${frontId}.`
        });
      }

      // 2) Vérifier que le parent existe
      const checkParent = await client.query(
        'SELECT id FROM entity_category WHERE id = $1',
        [ecParentId]
      );
      if (checkParent.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          ok: false,
          error: `Aucun entity_category (parent) trouvé avec id=${ecParentId}.`
        });
      }

      let addedCount   = 0;
      let removedCount = 0;

      // 3) Ajouts
      for (const childId of addList) {
        const insertSQL = `
          INSERT INTO parent_enfant_category (ec_parent_id, ec_enfant_id, frontiere_id)
          SELECT $1, $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM parent_enfant_category
            WHERE ec_parent_id = $1
              AND ec_enfant_id = $2
              AND frontiere_id = $3
          );
        `;
        const r = await client.query(insertSQL, [ecParentId, childId, frontId]);
        addedCount += r.rowCount;
      }

      // 4) Suppressions
      for (const childId of removeList) {
        const deleteSQL = `
          DELETE FROM parent_enfant_category
          WHERE ec_parent_id = $1
            AND ec_enfant_id = $2
            AND frontiere_id = $3;
        `;
        const r = await client.query(deleteSQL, [ecParentId, childId, frontId]);
        removedCount += r.rowCount;
      }

      // 5) Recalculer la géométrie du parent à partir des enfants et de la nouvelle période
      const recomputed = await recomputeParentGeometry(
        client,
        frontId,
        ecParentId,
        startStr,
        endStr
      );

      await client.query('COMMIT');

      return res.json({
        ok: true,
        result: {
          operation:        'edit-borders-dates',
          frontiereId:      frontId,
          ecParentId:       ecParentId,
          updatedFrontiere: rowsFront[0],      // dates mises à jour
          added:            addedCount,
          removed:          removedCount,
          recomputedFrontiere: recomputed     // union des enfants pour cette période
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erreur /api/editor/apply (edit-borders-dates) :', err);
      return res.status(500).json({
        ok: false,
        error: 'Erreur serveur lors de la mise à jour (edit-borders-dates).'
      });
    } finally {
      client.release();
    }
  }

  /***********************
   * 6) CHANGE-PARENT
   *    - Détache un enfant de son parent actuel (via frontiere_id)
   *    - Rattache cet enfant à un nouveau parent (trouvé par nom + date)
   *    - Recalcule les deux géométries (Ancien Parent et Nouveau Parent)
   ***********************/
  if (op === 'duplicate-entity') {
    const parent     = body.parent || {};
    const period     = body.period || {};
    const selections = body.selections || {};

    const frontId    = parent.frontiereId;
    const ecParentId = parent.entityCategoryId;

    const startStr = period.start;
    const endStr   = period.end;
    const geometry = body.geometry || body.newGeometry || null;

    const addList    = normalizeIdList(selections.add);
    const removeList = normalizeIdList(selections.remove);

    const problems = [];
    if (!frontId)    problems.push('frontiereId source manquant pour duplicate-entity.');
    if (!ecParentId) problems.push('entityCategoryId manquant pour duplicate-entity.');
    if (!startStr || !isValidISODate(startStr)) problems.push('Date de début invalide ou manquante.');
    if (!endStr   || !isValidISODate(endStr))   problems.push('Date de fin invalide ou manquante.');
    if (startStr && endStr && isValidISODate(startStr) && isValidISODate(endStr)) {
      const d1 = new Date(startStr);
      const d2 = new Date(endStr);
      if (d1.getTime() > d2.getTime()) problems.push('La date de début doit être <= à la date de fin.');
    }
    if (!geometry) problems.push('Aucune géométrie fournie (utilise la prévisualisation).');

    if (problems.length > 0) {
      return res.status(400).json({ ok: false, error: problems.join(' ') });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // debut de transaction

      const checkFront = await client.query('SELECT id FROM frontiere WHERE id = $1', [frontId]);
      if (checkFront.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: `Frontière source ${frontId} introuvable.` });
      }

      const newFront = await insertFrontiereFromGeometry(client, geometry, startStr, endStr);
      if (!newFront) throw new Error('Création de la nouvelle frontière échouée.');
      const newFrontiereId = newFront.id;

      await client.query(
        `INSERT INTO parent_enfant_category(ec_parent_id, ec_enfant_id, frontiere_id)
         SELECT ec_parent_id, ec_enfant_id, $1
         FROM parent_enfant_category
         WHERE frontiere_id = $2`,
        [newFrontiereId, frontId]
      );

      let addedCount = 0;
      let removedCount = 0;
      for (const childId of addList) {
        const r = await client.query(
          `INSERT INTO parent_enfant_category(ec_parent_id, ec_enfant_id, frontiere_id)
           SELECT $1, $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM parent_enfant_category
             WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3
           )`,
          [ecParentId, childId, newFrontiereId]
        );
        addedCount += r.rowCount;
      }
      for (const childId of removeList) {
        const r = await client.query(
          `DELETE FROM parent_enfant_category
           WHERE ec_parent_id = $1 AND ec_enfant_id = $2 AND frontiere_id = $3`,
          [ecParentId, childId, newFrontiereId]
        );
        removedCount += r.rowCount;
      }

      const recomputed = await recomputeParentGeometry(client, newFrontiereId, ecParentId, startStr, endStr);

      await client.query('COMMIT');
      return res.json({
        ok: true,
        result: {
          operation: 'duplicate-entity',
          sourceFrontiereId: frontId,
          newFrontiereId,
          added: addedCount,
          removed: removedCount,
          recomputedFrontiere: recomputed
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erreur /api/editor/apply (duplicate-entity) :', err);
      return res.status(500).json({ ok: false, error: 'Erreur serveur lors de la duplication.' });
    } finally {
      client.release();
    }
  }

  if (op === 'change-parent') {
    const child         = body.child || {};
    const newParentData = body.newParent || {};
    
    const dateRef       = body.dateReference; // Date cible (ex: 2025)
    // On utilise la date de la carte (si fournie) pour trouver qui supprimer, sinon repli sur dateRef
    const dateMap       = body.currentMapDate || dateRef; 

    const childEcId     = child.entityCategoryId;
    const newParentName = newParentData.name;

    const problems = [];
    if (!childEcId) problems.push('L’entité à déplacer (enfant) est mal définie.');
    if (!newParentName) problems.push('Le nom du nouveau parent est manquant.');
    if (!dateRef || !isValidISODate(dateRef)) problems.push('Date de référence invalide.');

    if (problems.length > 0) return res.status(400).json({ ok: false, error: problems.join(' ') });

    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // debut de transaction

      // 1) Trouver le NOUVEAU Parent (Category ID)
      const findParentCatSQL = `
        SELECT ec.id 
        FROM entity_category ec
        JOIN category c ON c.id = ec.category_id
        JOIN entity e   ON e.id = ec.entity_id
        WHERE LOWER(e.name) = LOWER($1) OR LOWER(c.name) = LOWER($1)
        LIMIT 1;
      `;
      const resNewParentCat = await client.query(findParentCatSQL, [newParentName.trim()]);
      if (resNewParentCat.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: `Nouveau parent "${newParentName}" introuvable.` });
      }
      const newParentEcId = resNewParentCat.rows[0].id;

      // 2) Trouver la frontière active du NOUVEAU Parent (Celle qui recevra l'enfant)
      const findNewFrontierSQL = `
        SELECT DISTINCT f.id 
        FROM frontiere f
        JOIN parent_enfant_category pec ON pec.frontiere_id = f.id
        WHERE pec.ec_parent_id = $1
        AND (f.date_debut IS NULL OR f.date_debut <= $2::date)
        AND (f.date_fin   IS NULL OR f.date_fin   >= $2::date)
        LIMIT 1;
      `;
      const resNewFrontier = await client.query(findNewFrontierSQL, [newParentEcId, dateRef]);
      if (resNewFrontier.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: `Le nouveau parent "${newParentName}" n'a pas de frontière active à la date cible (${dateRef}).` });
      }
      const newParentFrontierId = resNewFrontier.rows[0].id;

      // 3) RETROUVER L'ANCIEN PARENT ET LE DETACHER
      // On cherche qui possède l'enfant à la date de la carte (dateMap)
      const findOldLinkSQL = `
        SELECT pec.frontiere_id, pec.ec_parent_id
        FROM parent_enfant_category pec
        JOIN frontiere f_parent ON f_parent.id = pec.frontiere_id
        WHERE pec.ec_enfant_id = $1
          AND (f_parent.date_debut IS NULL OR f_parent.date_debut <= $2::date)
          AND (f_parent.date_fin   IS NULL OR f_parent.date_fin   >= $2::date)
        LIMIT 1;
      `;
      const resOldLink = await client.query(findOldLinkSQL, [childEcId, dateMap]);
      
      let oldParentFrontierId = null;

      if (resOldLink.rows.length > 0) {
        oldParentFrontierId = resOldLink.rows[0].frontiere_id;
        
        // Suppression du lien existant
        const deleteSQL = `DELETE FROM parent_enfant_category WHERE ec_enfant_id = $1 AND frontiere_id = $2`;
        await client.query(deleteSQL, [childEcId, oldParentFrontierId]);
        console.log(`[ChangeParent] Lien supprimé avec l'ancien parent (Frontière ID: ${oldParentFrontierId})`);
      } else {
        // Si on ne trouve pas d'ancien parent, ce n'est pas grave, on fait juste l'ajout
        console.log(`[ChangeParent] ⚠️ Aucun ancien parent trouvé pour l'enfant ${childEcId} à la date ${dateMap}.`);
      }

      // 4) Créer le lien avec le Nouveau Parent
      const insertSQL = `
        INSERT INTO parent_enfant_category (ec_parent_id, ec_enfant_id, frontiere_id)
        VALUES ($1, $2, $3)
      `;
      await client.query(insertSQL, [newParentEcId, childEcId, newParentFrontierId]);

      // 5) Recalculer les géométries des deux parents concernés
      if (oldParentFrontierId) {
        await recomputeParentGeometry(client, oldParentFrontierId, null, null, null);
      }
      await recomputeParentGeometry(client, newParentFrontierId, null, null, null);

      await client.query('COMMIT');

      return res.json({
        ok: true,
        result: {
          operation: 'change-parent',
          message: `Succès : Entité déplacée vers ${newParentName}.`
        }
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erreur change-parent:', err);
      return res.status(500).json({ ok: false, error: 'Erreur serveur lors du changement de parent.' });
    } finally {
      client.release();
    }
  }

  /***********************
   * 7) Autres opérations
   ***********************/
  return res.status(400).json({
    ok: false,
    error: `Opération "${op}" non encore supportée côté serveur.`
  });
});


/************************************************************
 * Catch-all : renvoie index.html sur /
 ************************************************************/
app.get('/', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

/************************************************************
 * Démarrage
 ************************************************************/
app.listen(PORT, () => {
  console.log(`API prête sur http://localhost:${PORT}`);
});
