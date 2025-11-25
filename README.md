# Praxis

Plateforme cartographique interactive pour explorer l'évolution des frontières (Leaflet + Node/Express + PostgreSQL/PostGIS) et un mode « éditeur » pour modifier les entités directement sur la carte.

## Prérequis
- Node.js (npm) pour le serveur Express (`server.js`).
- PostgreSQL avec PostGIS (requis par les requêtes `ST_` dans `server.js`).
- Variables d'environnement (voir `.env`) : `DATABASE_URL`, `PORT` (défaut 3000), `NODE_ENV`.

## Démarrage rapide
1) Installer les dépendances : `npm install`  
2) Configurer `.env` (copie l’exemple fourni).  
3) Lancer le serveur : `npm start` puis ouvrir http://localhost:3000.  
Les fichiers statiques sont servis depuis `public/`.

## Structure
- `server.js` : API Express (`/api/frontieres`, `/api/editor/apply`) + statiques.
- `public/index.html`, `public/script.js`, `public/style.css` : carte Leaflet, barre temporelle, sidebar, mode éditeur.
- `public/Data/datasociete.json` : données illustratives (bannières + métadonnées FR).
- `.env` : configuration locale PostgreSQL.

## API
- `GET /api/frontieres?date=YYYY-MM-DD&types=countries,districts,...&bbox=west,south,east,north&zoom=N`  
  Retourne un `FeatureCollection` GeoJSON (properties : `frontiere_id`, `when`, `entity_id`, `entity_name`, `entity_category_id`, `category_name`, `parent_name`).  
  Simplification géométrique automatique selon le zoom (`geom_z2 / z1 / z0`).
- `POST /api/editor/apply` (corps JSON)  
  Opérations supportées côté serveur : `edit-dates`, `edit-borders`, `edit-borders-dates`, `edit-borders-split`, `duplicate-entity`, `change-parent`.  
  Modifie les liens `parent_enfant_category`, met à jour `frontiere` et recalcule la géométrie parent (union des enfants).

## A) Site (mode normal)
Fonctionnel :
- Carte mondiale Leaflet (tuiles ArcGIS) avec limites de déplacement et contrôles de zoom custom.
- Barre temporelle digitale (année/mois/jour, pas de +/- par chiffre) qui recharge dynamiquement les couches via `/api/frontieres`.
- Chargement progressif des niveaux (ADM0/1/2) selon le zoom, avec styles adaptés et contrôle de visibilité.
- Sidebar basique affichant nom + bannière d’après `public/Data/datasociete.json` pour la France.

À améliorer / non finalisé :
- Recherche : le champ existe mais la recherche métier n’est pas branchée (message “Recherche simple non encore branchée”).
- Données sidebar limitées :  à l’exemple FR (modes de production, évènements, médias absents).
- intégrer de nouvelles données à la side bar en internationaliser les données et bannières au-delà de `societe.FR`.:
    -> Mode de production
    -> Créer des graphiques en javascript
    -> Lecteur de musique
    -> Livres de l'époque

Pistes de features à ajouter :
- Brancher la vraie recherche (par nom d’entité, période, catégorie) + autocomplétion.
- Lancer/arrêter l’animation temporelle (play/pause) pour voir le temps défiler tout seul
- Surcouches “évènements/conflits” et indicateurs socio-éco dans la sidebar (graphes, médias, etc.).


## B) Mode « éditeur »
Accès : taper `editeur` dans la barre de recherche pour basculer l’UI (panneau dédié, styles carte).  
Principe : choisir une entité parente, verrouiller, sélectionner des enfants (ajout vert / retrait rouge), prévisualiser la nouvelle frontière (union/différence avec Turf.js), puis sauvegarder via l’API.

Fonctionnel (front) :
- Choix de l’opération : `edit-borders(-dates/-split)`, `edit-dates`, `duplicate-entity`, `change-parent`, `create-entity` (UI).
- Verrouillage de l’entité parente, choix du niveau enfant (countries/districts/municipalities), dates par défaut alignées sur la carte.
- Sélection interactive d’enfants avec surbrillance, compteur et prévisualisation géométrique (couche orange).
- Bouton “Sauvegarder” envoie `/api/editor/apply` pour les opérations actuellement gérées serveur.

Limites actuelles :
- L’option UI `create-entity` n’a pas encore de branche côté serveur (le POST renverra une erreur “Opération non supportée”).
- Classification add/remove se fait sur le centroïde (peut être imprécis pour des polygones complexes imbriqués).
- Pas de recherche assistée d’entité par nom dans l’éditeur (saisie libre seulement).
- Pas de validations géographiques avancées (chevauchements, trous) avant envoi.

Features à mettre en place (éditeur) :
- Implémenter `/api/editor/apply` pour `create-entity` (création entité + catégorie + frontière + liens enfants).
- Robustifier `edit-borders-split` avec tests de bords (segments de période, suppression des doublons) et UI de confirmation.
- Ajout d’une option “play” sur la timeline de l’éditeur pour explorer l’effet des dates.
- Recherche/auto-complétion des entités + focus carte depuis la sidebar.
- Historique/undo des modifications et journalisation des opérations en base.

## Notes base de données
- Tables attendues : `frontiere` (geom, geom_z0/1/2, geojson, date_debut, date_fin), `entity`, `category`, `entity_category`, `parent_enfant_category`.
- PostGIS requis (`ST_Intersects`, `ST_MakeEnvelope`, `ST_Union`, `ST_SimplifyPreserveTopology`, `ST_AsGeoJSON`).
- Les opérations d’édition ouvrent des transactions et recalculent la géométrie parente après modification des liens.

## Dépannage rapide
- Rien ne s’affiche : vérifier `DATABASE_URL` et que PostGIS est activé (sinon `/api/frontieres` renvoie 500).
- Frontière manquante dans l’éditeur : assure-toi d’être au bon zoom/niveau et que la période couvre la date choisie.
- Sauvegarde en erreur : regarder la console serveur, l’API renvoie un message explicite (`400/404/500`) selon le cas.