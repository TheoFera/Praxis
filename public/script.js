////////////// initialisation des boutons ////////////
////Side bar 
const toggleButton = document.getElementById('toggle-button');
const sideBar = document.getElementById('side-bar');

function hideBanner() {
  const img = document.getElementById('properties-img');
  if (img) img.src = '';                 // déclenche la règle CSS [src=""] => display:none
  sideBar?.classList.add('no-banner');
}
function showBanner(src) {
  const img = document.getElementById('properties-img');
  if (img) img.src = src || '';
  if (src) sideBar?.classList.remove('no-banner');
  else     sideBar?.classList.add('no-banner');
}

// Récupération des éléments de la sidebar (searchbar + zones de texte)
const searchInput = document.getElementById('searchbar');
const searchBtn   = document.getElementById('searchBtn');
const sideContent = document.getElementById('contenu');    // zone de contenu
const sideTitle   = document.getElementById('titre');      // titre
const sideSub     = document.getElementById('sous-titre'); // sous-titre

// Sécurités : si l’HTML n’est pas encore chargé, attendre le DOM ready
if (!searchInput || !searchBtn) {
  document.addEventListener('DOMContentLoaded', () => {
    initSearchbarListeners();
  });
} else {
  initSearchbarListeners();
}

function initSearchbarListeners() {
  const input = document.getElementById('searchbar');
  const btn   = document.getElementById('searchBtn');

  if (!input || !btn) return;

  // 1) Touche "Entrée" au clavier dans l'input
  input.addEventListener('keydown', (e) => {
    console.log("Press Enter")
    if (e.key === 'Enter') {
      const value = input.value || '';
      if (handleSearchCommand(value)) return; // commande spéciale gérée : mode éditeur
      runNormalSearch(value);                 // sinon faire une recherche normale
    }
  });

  // 2) Clic sur le bouton OK loupe pour démarrer la recherche (searchBtn)
  btn.addEventListener('click', () => {
    const value = input.value || '';
    if (handleSearchCommand(value)) return; // commande spéciale gérée : vérifie si on passe ou non au mode éditeur
    runNormalSearch(value); // sinon faire une recherche normale
  });
}

// Recherche "normale" (temporaire) : pour l’instant, on affiche juste une info
function runNormalSearch(value) {
  // À brancher plus tard sur ta vraie logique de recherche.
  // Pour ne pas te casser le flux maintenant, on met un simple feedback.
  if (sideContent) {
    hideBanner();
    //sideBar?.classList.add('active');
    //if (sideTitle) sideTitle.innerText = 'Recherche';
    //if (sideSub)   sideSub.innerText   = value ? `“${value}”` : '';
    sideContent.innerHTML = `<div>Recherche simple non encore branchée. Tape <code>editeur</code> pour activer l’éditeur.</div>`;
  }
}



////////////// Mode editeur ////////////
let editorMode = false;        // drapeau qui dit si on est en mode éditeur
let previousSidebarHTML = "";  // pour restaurer la sidebar quand on quitte l’éditeur

let selectionActive = false;                 // bouton ON/OFF de sélection
const selectedAddIds    = new Set();         // enfants à AJOUTER (vert)
const selectedRemoveIds = new Set();         // enfants à RETIRER (rouge)
const selectedLayers    = new Map();         // id -> layer courant (références éphémères)

let parentLayer = null;                      // layer de la mère
let parentGeom  = null;                      // géométrie GeoJSON de la mère

let draftGroup = null;                       // future couche de preview (union, etc.)



////////////////// Partie sur le Geojson //////////////////

// --- Initialisation de la carte ---
// Création de la carte Leaflet sans le contrôle de zoom par défaut
var map = L.map('mapid', {zoomControl: false}).setView([35.00, 2.00], 3);
// Chargement des tuiles satellites fournies par ArcGIS
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 10,
    minZoom: 2,
}).addTo(map);
// Ajout du contrôle de zoom en bas à droite
new L.Control.Zoom({ position: 'bottomright' }).addTo(map);
// Retire le préfixe "Leaflet" de l'attribution
map.attributionControl.setPrefix(false);

// --- Gestion des limites de la carte ---
// Empêche l'utilisateur de se déplacer en dehors du monde affiché
var southWest = L.latLng(-89.98155760646617, -180),
    northEast = L.latLng(89.99346179538875, 180);
var bounds = L.latLngBounds(southWest, northEast);
map.setMaxBounds(bounds);
// Couche dédiée aux aperçus/drafts (créée une fois que 'map' existe)
draftGroup = L.layerGroup().addTo(map);

let currentAbort = null;
function abortPending() {
  if (currentAbort) { currentAbort.abort(); currentAbort = null; }
}

var codesoc = ""; // contiendra le code de la société sélectionnée

////// Nouveau : contiendra la FeatureCollection renvoyée par l'API
var pays = { type: 'FeatureCollection', features: [] };

// --- Style appliqué au GeoJSON ---
/*var Paysstyle = {
    "color": "#C0C0C0",
    "weight": 1,
    "opacity": 1,
    "fillOpacity": 0.1,
};*/

// Seuils de zoom recommandés
const DISTRICT_Z = 6;   // dès 4 on montre ADM1
const MUNIC_Z    = 8;   // dès 6 on montre ADM2

// Styles adaptatifs (en fonction du zoom courant)
const styleCountries = (z) => ({
  pane: 'countries',
  color: '#888',
  weight: Math.max(0.5, z/3 - 0.3),
  fillOpacity: 0.05
});
const styleDistricts = (z) => ({
  pane: 'districts',
  color: '#888',
  weight: Math.max(0.7, z/2 - 0.5),
  fillOpacity: 0.03
});
const styleMunicipalities = (z) => ({
  pane: 'municipalities',
  color: '#888',
  weight: Math.max(1, z - 5),
  fillOpacity: 0.02
});


// --- Définition des couches de filtres ---
var Filtrepays = L.layerGroup();      // contiendra les polygones des pays
var Layername = "Pays";               // nom utilisé dans le contrôle de couche
var Filtres = {
    "Pays": Filtrepays,
    //"Mode de production": FiltreMOP
};

// Groupes de couches
const groupCountries      = L.layerGroup().addTo(map); // visible par défaut
const groupDistricts      = L.layerGroup();
const groupMunicipalities = L.layerGroup();

const overlays = new Map(); // name -> layerGroup
const layersControl = L.control.layers(null, overlays, {position:'bottomright'}).addTo(map);

// 4) Ajouts initiaux
addOverlay('Pays', groupCountries);
addOverlay('Régions', groupDistricts);
addOverlay('Département', groupMunicipalities);

function addOverlay(name, layerGroup) {
  if (!overlays.has(name)) {
    overlays.set(name, layerGroup);
    layersControl.addOverlay(layerGroup, name);
  }
}

function removeOverlay(name) {
  const lg = overlays.get(name);
  if (lg) {
    // retire du contrôle et de la carte si visible
    layersControl.removeLayer(lg);
    map.removeLayer(lg);
    overlays.delete(name);
  }
}

map.createPane('countries');      map.getPane('countries').style.zIndex = 200;
map.createPane('districts');      map.getPane('districts').style.zIndex = 300;
map.createPane('municipalities'); map.getPane('municipalities').style.zIndex = 400;


function normalize(s){ return String(s||'').toLowerCase(); }
const isCountry      = (s) => /adm0|country|countries|pays/.test(normalize(s));
const isDistrict     = (s) => /adm1|district|region|state/.test(normalize(s));
const isMunicipality = (s) => /adm2|municipal|commune|county/.test(normalize(s));

//Recharge le layer à chaque changement de date
async function fetchFrontieres(dateISO, bboxCSV, typesCSV, zoom) {
  const url = `/api/frontieres?date=${dateISO}&types=${typesCSV}&zoom=${zoom}&bbox=${bboxCSV}`;
  const resp = await fetch(url, { signal: currentAbort?.signal });
  if (!resp.ok) throw new Error('API ' + resp.status);
  return await resp.json();
}

async function MAJLayersMulti() {
  abortPending();
  currentAbort = new AbortController();

  const z = map.getZoom();
  const b = map.getBounds().pad(0.05);
  const bboxCSV = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
                    .map(v => v.toFixed(6)).join(',');
  const dateISO = date.toISOString().split('T')[0];
  const forceDistricts = editorMode && editor.granularity === 'districts';
  const forceMunicip   = editorMode && editor.granularity === 'municipalities';

  // on efface les couches existantes
  [groupCountries, groupDistricts, groupMunicipalities].forEach(g => g.clearLayers());

  try {
    // 1) Pays (toujours)
    const fc0 = await fetchFrontieres(dateISO, bboxCSV, 'countries', z);
    L.geoJSON(fc0, {
      pane: 'countries',
      style: () => styleCountries(z),
      filter: (f) => {
        const w = f.properties?.when || [null, null];
        const startOk = !w[0] || new Date(w[0]) <= date;
        const endOk   = !w[1] || new Date(w[1]) >= date;
        return startOk && endOk;
      },
      onEachFeature
    }).addTo(groupCountries);

    // 2) Districts (force si l'éditeur demande ce niveau)
    if (z >= DISTRICT_Z || forceDistricts) {
      const fc1 = await fetchFrontieres(dateISO, bboxCSV, 'districts', z);
      L.geoJSON(fc1, {
        pane: 'districts',
        style: () => styleDistricts(z),
        filter: (f) => {
          const w = f.properties?.when || [null, null];
          const startOk = !w[0] || new Date(w[0]) <= date;
          const endOk   = !w[1] || new Date(w[1]) >= date;
          return startOk && endOk;
        },
        onEachFeature
      }).addTo(groupDistricts);
    }

    // 3) Municipalities (force si l'éditeur demande ce niveau)
    if (z >= MUNIC_Z || forceMunicip) {
      const fc2 = await fetchFrontieres(dateISO, bboxCSV, 'municipalities', z);
      L.geoJSON(fc2, {
        pane: 'municipalities',
        style: () => styleMunicipalities(z),
        filter: (f) => {
          const w = f.properties?.when || [null, null];
          const startOk = !w[0] || new Date(w[0]) <= date;
          const endOk   = !w[1] || new Date(w[1]) >= date;
          return startOk && endOk;
        },
        onEachFeature
      }).addTo(groupMunicipalities);
    }

  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  } finally {
    currentAbort = null;
    updateVisibility();
  }
}


function onEachFeature(feature, layer){
  const props = feature.properties || {};
  const entityId          = props.entity_id;
  const entityCategoryId  = props.entity_category_id;
  const parentNameFromGeo = props.parent_name; // <--- Récupéré du GeoJSON modifié
  const lvl               = levelFromCategoryName(props.category_name);
  
  layer.on('click', () => {
    sideBar.classList.add('active');

    const entityName   = props.entity_name ?? 'Nom inconnu';
    const categoryName = props.category_name ?? 'Catégorie inconnue';

    const titreEl = document.getElementById('titre');
    const sousEl  = document.getElementById('sous-titre');
    if (titreEl) titreEl.innerText = entityName;
    if (sousEl)  sousEl.innerText  = categoryName;

    if (!editorMode) return;

    const childKey = (entityCategoryId != null) ? entityCategoryId : entityId;

    // A) SÉLECTION D'ENFANTS (Inchangé...)
    if (selectionActive && lvl && lvl === editor.granularity && childKey != null) {
       // ... (Ton code existant pour selectedAddIds / RemoveIds) ...
       // (Je ne le répète pas pour gagner de la place, garde ton bloc A actuel)
       const kind = classifyChildSelection(feature); 
       if (kind === 'add') {
          if (selectedAddIds.has(childKey)) { selectedAddIds.delete(childKey); selectedLayers.delete(childKey); applyDefaultStyle(layer, lvl); }
          else { selectedAddIds.add(childKey); selectedRemoveIds.delete(childKey); selectedLayers.set(childKey, layer); layer.setStyle(styleAdd()); }
       } else {
          if (selectedRemoveIds.has(childKey)) { selectedRemoveIds.delete(childKey); selectedLayers.delete(childKey); applyDefaultStyle(layer, lvl); }
          else { selectedRemoveIds.add(childKey); selectedAddIds.delete(childKey); selectedLayers.set(childKey, layer); layer.setStyle(styleRemove()); }
       }
       if (typeof window.__editorRefreshSelectionCounter === 'function') window.__editorRefreshSelectionCounter();
       return; 
    }

    // B) CHOIX DE L'ENTITÉ (Mère ou Change-Parent)
    if (!selectionActive && !editor.parentLocked) {
      
      // --- 1. CAS : Sélection de la DESTINATION (Nouveau Parent) ---
      if (editor.operation === 'change-parent' && editor.pickingTarget === 'newParent') {
        editor.newParent = {
          id: entityId,
          name: entityName,
          category: categoryName
        };
        editor.pickingTarget = 'child'; // On remet le curseur sur child par sécurité
        
        // ★ RAFRAÎCHISSEMENT IMMÉDIAT DU PANNEAU
        if (sideContent) {
           sideContent.innerHTML = renderEditorPanel();
           attachEditorPanelEvents();
        }
        return; 
      }

      // --- 2. CAS : Sélection de l'ENFANT (Entité à déplacer ou Mère standard) ---
      if (parentLayer) {
        const oldLvl = levelFromCategoryName(parentLayer.feature?.properties?.category_name);
        applyDefaultStyle(parentLayer, oldLvl);
      }

      editor.selectedParent = {
        id:               entityId ?? null,
        entityCategoryId: entityCategoryId ?? null,
        name:             entityName,
        category:         categoryName,
        currentParentName: parentNameFromGeo // Stocké pour l'affichage
      };
      editor.parentLevel = lvl || null;

      const frontiereId = (feature.properties && feature.properties.frontiere_id) ?? feature.id ?? null;
      editor.parentFrontiereId = frontiereId;

      parentLayer = layer;
      parentGeom  = feature.geometry;
      parentLayer.setStyle(styleParent());

      // Logique dates (inchangée)
      const when = feature.properties?.when;
      if (Array.isArray(when)) {
        const [wStart, wEnd] = when;
        if (wStart) editor.startDate = wStart;
      if (wEnd)   editor.endDate   = wEnd;
      }
      
      if (lvl === 'countries') editor.granularity = 'districts';
      else if (lvl === 'districts') editor.granularity = 'municipalities';
      if (editor.operation === 'create-entity') {
        editor.newEntityCategory = editor.granularity;
      }

      // ★ RAFRAÎCHISSEMENT IMMÉDIAT (CRITIQUE POUR UX)
      // Si on est en mode change-parent, on veut voir le bouton se mettre à jour tout de suite
      if (editor.operation === 'change-parent') {
         if (sideContent) {
           sideContent.innerHTML = renderEditorPanel();
           attachEditorPanelEvents();
         }
      } else {
         // Mode standard
         const view = document.getElementById('editor-parent-view');
         if (view) {
            const span = view.querySelector('span');
            if (span) span.textContent = `${editor.selectedParent.name} (${editor.selectedParent.category})`;
         }
         const msg  = document.getElementById('editor-msg');
         if (msg) renderSummary(msg);
      }
    }
  });

  // Restauration du style au chargement si nécessaire (inchangé)
  const existingChildKey = (entityCategoryId != null) ? entityCategoryId : entityId;
  if (existingChildKey != null) {
    if (selectedAddIds.has(existingChildKey)) { selectedLayers.set(existingChildKey, layer); layer.setStyle(styleAdd()); } 
    else if (selectedRemoveIds.has(existingChildKey)) { selectedLayers.set(existingChildKey, layer); layer.setStyle(styleRemove()); }
  }
  if (editor.selectedParent && entityId === editor.selectedParent.id) {
    parentLayer = layer;
    parentGeom  = feature.geometry;
    layer.setStyle(styleParent());
  }
}


function updateVisibility(){
  const z = map.getZoom();
  const hasDistricts = groupDistricts.getLayers().length > 0;
  const hasMunicip   = groupMunicipalities.getLayers().length > 0;

  // Toujours afficher les pays (couche de base)
  if (!map.hasLayer(groupCountries)) map.addLayer(groupCountries);

  const countriesPane      = map.getPane('countries');
  const districtsPane      = map.getPane('districts');
  const municipalitiesPane = map.getPane('municipalities');

  // En mode editeur : visibilite pilotee par "Niveau des enfants a modifier"
  if (editorMode) {
    const target = editor.granularity || 'countries';

    if (countriesPane)      countriesPane.style.pointerEvents = 'none';
    if (districtsPane)      districtsPane.style.pointerEvents = 'none';
    if (municipalitiesPane) municipalitiesPane.style.pointerEvents = 'none';

    if (target === 'countries') {
      if (map.hasLayer(groupDistricts))      map.removeLayer(groupDistricts);
      if (map.hasLayer(groupMunicipalities)) map.removeLayer(groupMunicipalities);
      if (countriesPane) countriesPane.style.pointerEvents = 'auto';
    } else if (target === 'districts') {
      if (!map.hasLayer(groupDistricts)) map.addLayer(groupDistricts);
      if (map.hasLayer(groupMunicipalities)) map.removeLayer(groupMunicipalities);
      if (districtsPane && hasDistricts) districtsPane.style.pointerEvents = 'auto';
    } else if (target === 'municipalities') {
      if (!map.hasLayer(groupDistricts)) map.addLayer(groupDistricts); // contexte parent
      if (!map.hasLayer(groupMunicipalities)) map.addLayer(groupMunicipalities);
      if (municipalitiesPane && hasMunicip) municipalitiesPane.style.pointerEvents = 'auto';
    }
    return;
  }

  // Mode normal : visibilite automatique selon le zoom
  if (z >= DISTRICT_Z) { if (!map.hasLayer(groupDistricts)) map.addLayer(groupDistricts); }
  else                 { if (map.hasLayer(groupDistricts))  map.removeLayer(groupDistricts); }

  if (z >= MUNIC_Z)    { if (!map.hasLayer(groupMunicipalities)) map.addLayer(groupMunicipalities); }
  else                 { if (map.hasLayer(groupMunicipalities))  map.removeLayer(groupMunicipalities); }

  const municipClickable   = (z >= MUNIC_Z) && hasMunicip;
  const districtsClickable = (z >= DISTRICT_Z && (z < MUNIC_Z || !municipClickable)) && hasDistricts;

  if (countriesPane)      countriesPane.style.pointerEvents      = (!hasDistricts || z < DISTRICT_Z) ? 'auto' : 'none';
  if (districtsPane)      districtsPane.style.pointerEvents      = districtsClickable ? 'auto' : (municipClickable ? 'none' : 'auto');
  if (municipalitiesPane) municipalitiesPane.style.pointerEvents = municipClickable ? 'auto' : 'none';
}

// Débounce des rafraichissements lourds (requête API)
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => MAJLayersMulti(), 300);
}

map.on('zoomend', () => {
  // restyle rapide
  const z = map.getZoom();
    [groupCountries, groupDistricts, groupMunicipalities].forEach(g=>{
    g.eachLayer(l => {
      if (!l.setStyle) return;
      const props = l.feature?.properties || {};
      const lvl   = levelFromCategoryName(props.category_name);
      const entId = props.entity_id;
      const childKey =
        (props.entity_category_id != null) ? props.entity_category_id : entId;

      if (editor.selectedParent && entId === editor.selectedParent.id) {
        // La mère
        l.setStyle(styleParent());
      } else if (childKey != null && selectedAddIds.has(childKey)) {
        // Enfant à ajouter
        l.setStyle(styleAdd());
      } else if (childKey != null && selectedRemoveIds.has(childKey)) {
        // Enfant à retirer
        l.setStyle(styleRemove());
      } else if (typeof l.options.style === 'function') {
        l.setStyle(l.options.style());
      } else {
        applyDefaultStyle(l, lvl);
      }
    });
  });

  updateVisibility();
  scheduleRefresh();
});
map.on('moveend', scheduleRefresh);


////////////////  Side bar   ///////////////
toggleButton.addEventListener('click', show);

function show(){
    sideBar.classList.toggle('active');
    ChangeData(date, codesoc);
}
function cache(){
    sideBar.classList.remove('active');
}


/////////// Change la donnée dans la Side Bar /////////////

function ChangeData(date, code){
    
    var p = societe.FR;
    
        //p = societe.JSON.stringify(code);
        //peut-être faire un if "case" avec tous les codes parce que je n'arrive pas à mettre "code" en variable pour l'appel 
        //sinon ajouter une ramification en amont afin de pouvoir appeler "FR" avec un tableau
    var n =-1;
    var nom = "";
    while (nom==="" && n< p.length-1){
        n++;
        var startdate = new Date(p[n]["when"][0]);
        var enddate = new Date(p[n]["when"][1]);
        if(startdate < date  && enddate > date){
            nom = p[n]["nom"];
            banniere = p[n]["Banniere"];
        }
    }

    if (!banniere) hideBanner();
    else showBanner(banniere);

    //feature.properties.name;
    document.getElementById('titre').innerText = nom;
    document.getElementById('properties-img').src= banniere;
}





//////////////   Gestion des dates   //////////////////////////////

//Date
var date = new Date();
const datemin = new Date(-99000, 0, 1);
const datemax = new Date();

//date.setYear(-84321);
AfficheDate(date);

/*console.log(date.toISOString());
console.log(date.toISOString());
console.log(date.toISOString().split('T')[0]);*/

//Fonctions permettant d'incrémenter la date avec les flèches
//Jours
const djPlus = document.getElementById('dj-plus');
const djMoins = document.getElementById('dj-moins');
const ujPlus = document.getElementById('uj-plus');
const ujMoins = document.getElementById('uj-moins');
//Mois
const dmPlus = document.getElementById('dm-plus');
const dmMoins = document.getElementById('dm-moins');
const umPlus = document.getElementById('um-plus');
const umMoins = document.getElementById('um-moins');
//Années
const dmaPlus = document.getElementById('dma-plus');
const dmaMoins = document.getElementById('dma-moins');
const maPlus = document.getElementById('ma-plus');
const maMoins = document.getElementById('ma-moins');
const caPlus = document.getElementById('ca-plus');
const caMoins = document.getElementById('ca-moins');
const daPlus = document.getElementById('da-plus');
const daMoins = document.getElementById('da-moins');
const uaPlus = document.getElementById('ua-plus');
const uaMoins = document.getElementById('ua-moins');

//Flèches d'incrémentation des Jours
djPlus.addEventListener("click", function(){
    incrementer("+", 10, djPlus, "Jour");
});
djMoins.addEventListener("click", function(){
    incrementer("-", 10, djMoins, "Jour");
});
ujPlus.addEventListener("click", function(){
    incrementer("+", 1, ujPlus, "Jour");
});
ujMoins.addEventListener("click", function(){
    incrementer("-", 1, ujMoins, "Jour");
});
//Flèches d'incrémentation des Mois
dmPlus.addEventListener("click", function(){
    incrementer("+", 10, dmPlus, "Mois");
});
dmMoins.addEventListener("click", function(){
    incrementer("-", 10, dmMoins, "Mois");
});
umPlus.addEventListener("click", function(){
    incrementer("+", 1, umPlus, "Mois");
});
umMoins.addEventListener("click", function(){
    incrementer("-", 1, umMoins, "Mois");
});
//Flèches d'incrémentation des Années
dmaPlus.addEventListener("click", function(){
    incrementer("+", 10000, dmaPlus, "An");
});
dmaMoins.addEventListener("click", function(){
    incrementer("-", 10000, dmaMoins, "An");
});
maPlus.addEventListener("click", function(){
    incrementer("+", 1000, maPlus, "An");
});
maMoins.addEventListener("click", function(){
    incrementer("-", 1000, maMoins, "An");
});
caPlus.addEventListener("click", function(){
    incrementer("+", 100, caPlus, "An");
});
caMoins.addEventListener("click", function(){
    incrementer("-", 100, caMoins, "An");
});
daPlus.addEventListener("click", function(){
    incrementer("+", 10, daPlus, "An");
});
daMoins.addEventListener("click", function(){
    incrementer("-", 10, daMoins, "An");
});
uaPlus.addEventListener("click", function(){
    incrementer("+", 1, uaPlus, "An");
});
uaMoins.addEventListener("click", function(){
    incrementer("-", 1, uaMoins, "An");
});

//Fonction qui incrémente la date selon les paramètres entrés
function incrementer(Signe, Nb, bouton, type){

    if(type == "Jour"){
        if(Signe == "+"){
            date.setDate(date.getDate() + Nb);
        }else{
            date.setDate(date.getDate() - Nb);
        }
    }else if(type == "Mois"){
        if(Signe == "+"){
            date.setMonth(date.getMonth() + Nb);
        }else{
            date.setMonth(date.getMonth() - Nb);
        }
    }else if(type == "An"){
        if(Signe == "+"){
            date.setFullYear(date.getFullYear() + Nb);
        }else{
            date.setFullYear(date.getFullYear() - Nb);
        }
    }

    if(date > datemax){
        date = new Date(datemax);
    } else if(date < datemin){
        date = new Date(datemin);
    }
    activer(bouton);
    setTimeout(function(){activer(bouton)}, 100);
    
    AfficheDate(date); //Change l'affichage de la date
    ChangeData(date, codesoc); //Change les infos de la sidebar
}

 //fonction qui fait switcher active/inactives les flèches 
function activer(id){id.classList.toggle('active');}


//Fonctions qui affiche la date
function AfficheDate(Dateaafficher){
//Jour
var Jours = Div(Dateaafficher.getDate());
document.getElementById('dj').innerText = Jours[3];
document.getElementById('uj').innerText = Jours[4];
//Mois
var Mois = Div(Dateaafficher.getMonth()+1);
document.getElementById('dm').innerText = Mois[3];
document.getElementById('um').innerText = Mois[4];
//Année
if (Dateaafficher.getFullYear() < 0){
    document.getElementById('moins').innerText = "-";
} else {
    document.getElementById('moins').innerHTML = "&nbsp";
}
var An = Div(Math.abs(Dateaafficher.getFullYear()));
if (Math.abs(Dateaafficher.getFullYear()) < 10000){
    document.getElementById('dma').innerHTML = "&nbsp";
} else {
    document.getElementById('dma').innerText = An[0];
}
document.getElementById('ma').innerText = An[1];
document.getElementById('ca').innerText = An[2];
document.getElementById('da').innerText = An[3];
document.getElementById('ua').innerText = An[4];

MAJLayersMulti(); /*Ancien MAJLayers(Filtres, Filtrepays, Paysstyle); //Change les contours quand la date change*/
}

function Div(u){
    var dm = 0;
        m = 0;   
        c = 0;
        d = 0;

    while(u>9999){
        u = u-10000;
        dm = dm+1;
    }
    while(u>999){
        u = u-1000;
        m = m+1;
    }
    while(u>99){
        u = u-100;
        c = c+1;
    }
    while(u>9){
        u = u-10;
        d = d+1;
    }
    var Tableau = [dm, m, c ,d, u];
    return Tableau;
}



////////////// MODE EDITEUR //////////////////////////////

// Détecte les "commandes" de la searchbar (ici 'editeur')
function handleSearchCommand(value) {
  const cmd = value.trim().toLowerCase();
  if (cmd === 'editeur' || cmd === 'éditeur') {
    toggleEditorMode();
    return true; // on a géré la commande, on ne lance pas la recherche classique
  }
  return false; // pas une commande spéciale
}

// État de l’éditeur (mémoire locale côté front)
const editor = {
  operation: '',            // type d'opération choisie dans l'éditeur
  selectedParent: null,     // Dans le cas "change-parent", ceci représente l'ENFANT (l'entité à déplacer)
  newParent: null,          // ★ NOUVEAU : La destination (pour change-parent)
  pickingTarget: 'child',   // ★ NOUVEAU : 'child' ou 'newParent' (ce qu'on est en train de choisir sur la carte)
  action: 'modify',         // ancien paramètre (transition, on le gardera un moment)
  startDate: '',            // 'YYYY-MM-DD'
  endDate: '',              // 'YYYY-MM-DD'
  granularity: 'districts', // 'countries' | 'districts' | 'municipalities'
  parentLocked: false,      // vrai = on ne change plus l’entité mère par clic
  parentLevel: null,        // 'countries' | 'districts' | 'municipalities'
  parentFrontiereId: null,   // id de la ligne "frontiere" sélectionnée (si dispo dans properties)
  newGeometry: null      // 🔹 nouvelle géométrie de la mère après édition
};




// Bascule l’UI en mode éditeur (ou revient au mode normal)
// script.js - Correction de toggleEditorMode

function toggleEditorMode() {
  editorMode = !editorMode;

  if (editorMode) {
    // --- ENTRÉE EN MODE ÉDITEUR ---
    resetEditorState(); 
    
    // Sauvegarde l'état du panneau latéral
    if (sideContent) previousSidebarHTML = sideContent.innerHTML;
    if (sideTitle) sideTitle.innerText = 'Mode éditeur';
    if (sideSub)   sideSub.innerText   = 'Préparation des outils…';

    sideBar?.classList.add('editor');
    hideBanner();

    if (sideContent) {
      sideContent.innerHTML = renderEditorPanel();
      attachEditorPanelEvents();
    }
    if (sideBar) sideBar.classList.add('active'); 

  } else {
    // --- SORTIE DU MODE ÉDITEUR ---
    
    // 1. D'abord, on remet à zéro tout l'état logique
    resetEditorState(); 

    // 2. Restauration de l'interface
    if (sideTitle) sideTitle.innerText = 'Détails';
    if (sideSub)   sideSub.innerText   = '';
    if (sideContent) sideContent.innerHTML = previousSidebarHTML || '';

    if (sideBar) {
      sideBar.classList.remove('active');
      sideBar.classList.remove('editor');
    }

    // 3. IMPORTANT : On force le rechargement des calques pour nettoyer 
    // les styles "bleu/vert/rouge" résiduels sur la carte.
    MAJLayersMulti();
  }
}

// Rend le petit panneau d’édition (maquette)
function renderEditorPanel() {
  const currentISO = date.toISOString().split('T')[0];
  if (!editor.startDate) editor.startDate = currentISO;
  if (!editor.endDate)   editor.endDate   = currentISO;

  // Opération choisie (par défaut : modifier frontières + période sans split)
  const op = editor.operation || 'edit-borders-dates';

  const parentLabel = editor.selectedParent
    ? `${editor.selectedParent.name} (${editor.selectedParent.category ?? 'catégorie ?'})`
    : 'Aucune (clique un polygone sur la carte)';

  const hasParent   = !!editor.selectedParent;
  const hasLocked   = hasParent && editor.parentLocked;
  const s = editor.startDate ? new Date(editor.startDate) : null;
  const e = editor.endDate   ? new Date(editor.endDate)   : null;
  const datesOk     = !!(s && e && s <= e);

  let bodyHTML = '';

  if (!op) {
    // Aucune opération choisie : on affiche seulement un message d'aide
    bodyHTML = `
      <div id="editor-body">
        <div style="padding:8px; background:#fafafa; border:1px solid #eee; border-radius:6px;">
          <strong>Étape 1 :</strong> choisis ce que tu veux faire dans la liste ci-dessus.<br>
          Ensuite, l’éditeur affichera uniquement les options utiles.
        </div>
      </div>
    `;
  } else if (op === 'edit-borders' || op === 'edit-borders-dates' || op === 'edit-borders-split') {
  // Cas : modifier les frontières (avec ou sans modification de période / split)
  const isSplit = (op === 'edit-borders-split');
  const datesReadOnly = (op === 'edit-borders');
  const dateHelpText = datesReadOnly
    ? 'En mode "Modifier les frontières", ces dates viennent de la frontière sélectionnée et ne seront pas modifiées.'
    : isSplit
      ? 'Segmentera la frontière sur cette période, ajoutera/retirera les enfants et coupera les chevauchements.'
      : 'Ces dates correspondent à la période pendant laquelle ces frontières s’appliquent.';

  bodyHTML = `
      <div id="editor-body">

        <!-- Barre d'état des étapes -->
        <div style="border:1px solid #eee; border-radius:6px; padding:8px;">
          <div><strong>Étapes :</strong></div>
          <div>1️⃣ Entité mère : ${hasParent ? (hasLocked ? '✅ choisie & verrouillée' : '🟡 choisie, pense à la verrouiller') : '⚪ à choisir'}</div>
          <div>2️⃣ Période : ${datesOk ? '✅ dates valides' : '🟡 à compléter / corriger'}</div>
          <div>3️⃣ Sélection des enfants : 🟦 cliquer quand l’étape 1 est verrouillée</div>
        </div>

        <!-- Entité mère -->
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Entité mère</label>
          <div id="editor-parent-view" style="padding:8px; background:#f6f6f6; border:1px solid #e5e5e5; border-radius:6px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span>${parentLabel}</span>
            <button id="editor-parent-lock" type="button">${editor.parentLocked ? 'Déverrouiller' : 'Verrouiller'}</button>
          </div>
          <small>
            1) Clique un polygone pour choisir l’entité mère, puis <strong>verrouille</strong>.<br>
            2) Tant que ce n’est pas verrouillé, tu peux recliquer pour changer de mère.
          </small>
          <div style="display:flex; gap:6px; margin-top:6px;">
            <input id="editor-parent-input" type="text" placeholder="(optionnel) saisir/chercher un nom…" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:6px;">
            <button id="editor-parent-clear" type="button">Effacer</button>
          </div>
        </div>

        <!-- Période -->
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Période concernée</label>
          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de début</div>
              <input id="editor-start" type="date" value="${editor.startDate}" ${datesReadOnly ? 'disabled' : ''} style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de fin</div>
              <input id="editor-end" type="date" value="${editor.endDate}" ${datesReadOnly ? 'disabled' : ''} style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
          </div>
          <small id="editor-date-help" style="color:#666;">
            ${dateHelpText}
          </small>
        </div>

        <!-- Granularité (N-1) -->
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Niveau des enfants à modifier</label>
          <select id="editor-granularity" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            <option value="countries"      ${editor.granularity==='countries'?'selected':''}>Countries (ADM0)</option>
            <option value="districts"      ${editor.granularity==='districts'?'selected':''}>Districts / Régions (ADM1)</option>
            <option value="municipalities" ${editor.granularity==='municipalities'?'selected':''}>Municipalities / Communes (ADM2)</option>
          </select>
          <small>Ce niveau est déduit automatiquement du niveau de l’entité mère, mais tu peux encore l’ajuster ici pour l’instant.</small>
        </div>

        <!-- Sélection d'enfants -->
        <div class="field" style="border:1px dashed #ddd; padding:8px; border-radius:6px;">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Sélection d’enfants</label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button id="editor-select-toggle" type="button">${selectionActive ? 'Arrêter sélection' : 'Activer sélection'}</button>
            <button id="editor-select-clear" type="button">Vider la sélection</button>
            <span id="editor-select-count" style="opacity:0.85;">0 sélection(s)</span>
          </div>
          <small>
            • <span style="color:#2e7d32;">Vert</span> = enfants <strong>ajoutés</strong> à l’entité sur cette période<br>
            • <span style="color:#c62828;">Rouge</span> = enfants <strong>retirés</strong> de l’entité sur cette période
          </small>
        </div>

        <!-- Actions -->
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="editor-apply"  type="button" style="flex:1;">Prévisualiser la modification</button>
          <button id="editor-save"   type="button" style="flex:1;">Sauvegarder en base</button>
          <button id="btn-editor-exit" type="button">Quitter</button>
        </div>

        <!-- Messages / résumé -->
        <div id="editor-msg" style="padding:8px; background:#fafafa; border:1px solid #eee; border-radius:6px;">
          <em>Complète les champs ci-dessus. Un résumé s’affichera ici.</em>
        </div>

      </div>
    `;
    }  else if (op === 'edit-dates') {
    // Cas : ne modifier que les dates de la frontière (pas les enfants)
    bodyHTML = `
      <div id="editor-body">

        <!-- Entité mère / frontière ciblée -->
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Frontière à dater</label>
          <div id="editor-parent-view" style="padding:8px; background:#f6f6f6; border:1px solid #e5e5e5; border-radius:6px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span>${parentLabel}</span>
            <button id="editor-parent-lock" type="button">${editor.parentLocked ? 'Déverrouiller' : 'Verrouiller'}</button>
          </div>
          <small>
            Clique sur une frontière sur la carte pour choisir l’entité et la période actuelle.<br>
            Les dates ci-dessous seront pré-remplies avec la période de cette frontière.
          </small>
          <div style="display:flex; gap:6px; margin-top:6px;">
            <input id="editor-parent-input" type="text" placeholder="(optionnel) saisir/chercher un nom…" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:6px;">
            <button id="editor-parent-clear" type="button">Effacer</button>
          </div>
        </div>

        <!-- Période -->
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Nouvelle période de cette frontière</label>
          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de début</div>
              <input id="editor-start" type="date" value="${editor.startDate}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de fin</div>
              <input id="editor-end" type="date" value="${editor.endDate}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
          </div>
          <small id="editor-date-help" style="color:#666;">
            Tu modifies ici uniquement les dates de validité de cette frontière, pas sa forme ni ses enfants.
          </small>
        </div>

        <!-- (Plus tard : option "appliquer aux enfants") -->

        <!-- Actions -->
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="editor-apply"  type="button" style="flex:1;">Prévisualiser le changement de dates</button>
          <button id="editor-save"   type="button" style="flex:1;">Sauvegarder en base</button>
          <button id="btn-editor-exit" type="button">Quitter</button>
        </div>

        <!-- Messages / résumé -->
        <div id="editor-msg" style="padding:8px; background:#fafafa; border:1px solid #eee; border-radius:6px;">
          <em>Complète les dates puis prévisualise. On branchera ensuite la sauvegarde sur la base.</em>
        </div>

      </div>
    `;
  } else if (op === 'create-entity') {
    const catValue = editor.newEntityCategory || editor.granularity;

    bodyHTML = `
      <div id="editor-body">
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Entité parente</label>
          <div id="editor-parent-view" style="padding:8px; background:#f6f6f6; border:1px solid #e5e5e5; border-radius:6px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span>${parentLabel}</span>
            <button id="editor-parent-lock" type="button">${editor.parentLocked ? 'Déverrouiller' : 'Verrouiller'}</button>
          </div>
          <small>Choisis l'entité parente puis verrouille-la avant de sélectionner des enfants.</small>
          <div style="display:flex; gap:6px; margin-top:6px;">
            <input id="editor-parent-input" type="text" placeholder="(optionnel) saisir/chercher un nom" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:6px;">
            <button id="editor-parent-clear" type="button">Effacer</button>
          </div>
        </div>

        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Nom de la nouvelle entité</label>
          <input id="editor-new-entity-name" type="text" value="${editor.newEntityName || ''}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
        </div>

        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Période de validité</label>
          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de début</div>
              <input id="editor-start" type="date" value="${editor.startDate}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de fin</div>
              <input id="editor-end" type="date" value="${editor.endDate}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
          </div>
        </div>

        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Catégorie / niveau</label>
          <select id="editor-granularity" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            <option value="countries"      ${catValue==='countries'?'selected':''}>Countries (ADM0)</option>
            <option value="districts"      ${catValue==='districts'?'selected':''}>Districts / Régions (ADM1)</option>
            <option value="municipalities" ${catValue==='municipalities'?'selected':''}>Municipalities / Communes (ADM2)</option>
          </select>
          <small>Définit le type de la nouvelle entité et le niveau de sélection.</small>
        </div>

        <div class="field" style="border:1px dashed #ddd; padding:8px; border-radius:6px;">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Sélection d'enfants</label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button id="editor-select-toggle" type="button">${selectionActive ? 'ArrǦter sélection' : 'Activer sélection'}</button>
            <button id="editor-select-clear" type="button">Vider la sélection</button>
            <span id="editor-select-count" style="opacity:0.85;">0 sélection(s)</span>
          </div>
          <small>Utilise la sélection sur la carte pour dessiner la zone de la nouvelle entité.</small>
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="editor-apply"  type="button" style="flex:1;">Prévisualiser la nouvelle frontière</button>
          <button id="editor-save"   type="button" style="flex:1;">Créer en base</button>
          <button id="btn-editor-exit" type="button">Quitter</button>
        </div>

        <div id="editor-msg" style="padding:8px; background:#fafafa; border:1px solid #eee; border-radius:6px;">
          <em>Prévisualise pour générer la géométrie avant d'enregistrer.</em>
        </div>
      </div>
    `;
  } else if (op === 'duplicate-entity') {
    bodyHTML = `
      <div id="editor-body">
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Entité è dupliquer</label>
          <div id="editor-parent-view" style="padding:8px; background:#f6f6f6; border:1px solid #e5e5e5; border-radius:6px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span>${parentLabel}</span>
            <button id="editor-parent-lock" type="button">${editor.parentLocked ? 'Déverrouiller' : 'Verrouiller'}</button>
          </div>
          <small>Choisis la frontière è copier puis verrouille-la avant d'ajouter ou retirer des enfants.</small>
          <div style="display:flex; gap:6px; margin-top:6px;">
            <input id="editor-parent-input" type="text" placeholder="(optionnel) saisir/chercher un nom" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:6px;">
            <button id="editor-parent-clear" type="button">Effacer</button>
          </div>
        </div>

        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Nouvelle période</label>
          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de début</div>
              <input id="editor-start" type="date" value="${editor.startDate}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
            <div style="flex:1;">
              <div style="font-size:12px; opacity:0.8;">Date de fin</div>
              <input id="editor-end" type="date" value="${editor.endDate}" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            </div>
          </div>
        </div>

        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Niveau des enfants è ajuster</label>
          <select id="editor-granularity" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
            <option value="countries"      ${editor.granularity==='countries'?'selected':''}>Countries (ADM0)</option>
            <option value="districts"      ${editor.granularity==='districts'?'selected':''}>Districts / Régions (ADM1)</option>
            <option value="municipalities" ${editor.granularity==='municipalities'?'selected':''}>Municipalities / Communes (ADM2)</option>
          </select>
          <small>Optionnel : ajuste la copie en ajoutant ou retirant des enfants.</small>
        </div>

        <div class="field" style="border:1px dashed #ddd; padding:8px; border-radius:6px;">
          <label style="display:block; font-weight:600; margin-bottom:4px;">Sélection d'enfants</label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button id="editor-select-toggle" type="button">${selectionActive ? 'ArrǦter sélection' : 'Activer sélection'}</button>
            <button id="editor-select-clear" type="button">Vider la sélection</button>
            <span id="editor-select-count" style="opacity:0.85;">0 sélection(s)</span>
          </div>
          <small>Sers-toi de la sélection pour affiner la frontière copièe.</small>
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="editor-apply"  type="button" style="flex:1;">Prévisualiser la copie</button>
          <button id="editor-save"   type="button" style="flex:1;">Sauvegarder en base</button>
          <button id="btn-editor-exit" type="button">Quitter</button>
        </div>

        <div id="editor-msg" style="padding:8px; background:#fafafa; border:1px solid #eee; border-radius:6px;">
          <em>Prévisualise pour voir la frontière copiée puis ajustée.</em>
        </div>
      </div>
    `;
  } else if (op === 'change-parent') {
    
    // Construction du label Enfant avec le parent actuel
    let childLabel = '⚪ (Clique sur la carte)';
    if (editor.selectedParent) {
       const currP = editor.selectedParent.currentParentName 
         ? ` (Actuel: ${editor.selectedParent.currentParentName})` 
         : '';
       childLabel = `✅ ${editor.selectedParent.name}${currP}`;
    }
      
    const newParentLabel = editor.newParent
      ? `✅ ${editor.newParent.name}`
      : '⚪ (Clique sur le bouton "Choisir" puis sur la carte)';

    // Styles visuels
    const styleChildBtn = (editor.pickingTarget === 'child') 
      ? 'background:#e3f2fd; border-color:#2196f3; font-weight:bold; color:#0d47a1;' 
      : 'background:#fff; color:#333;';
      
    const styleNewParentBtn = (editor.pickingTarget === 'newParent') 
      ? 'background:#e8f5e9; border-color:#4caf50; font-weight:bold; color:#1b5e20;' 
      : 'background:#fff; color:#333;';

    bodyHTML = `
      <div id="editor-body">
        <!-- 1. Entité à déplacer -->
        <div class="field" style="margin-bottom:12px;">
          <label style="display:block; font-weight:600; margin-bottom:4px;">1. Entité à déplacer</label>
          <button id="btn-pick-child" type="button" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; cursor:pointer; text-align:left; ${styleChildBtn}">
             ${childLabel}
          </button>
        </div>

        <!-- 2. Nouveau Parent -->
        <div class="field" style="margin-bottom:12px;">
          <label style="display:block; font-weight:600; margin-bottom:4px;">2. Destination (Nouveau Parent)</label>
          <button id="btn-pick-newparent" type="button" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; cursor:pointer; text-align:left; ${styleNewParentBtn}">
             ${newParentLabel}
          </button>
          <small style="color:#666; display:block; margin-top:4px;">Clique ci-dessus, puis clique sur la carte.</small>
        </div>

        <!-- 3. Date -->
        <div class="field">
          <label style="display:block; font-weight:600; margin-bottom:4px;">3. Date de référence</label>
          <input id="editor-ref-date" type="date"
                 value="${editor.startDate || currentISO}"
                 style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
        </div>

        <!-- Zone de messages pour cette opération -->
        <div id="editor-msg"
             style="margin-top:12px; padding:8px; background:#fafafa;
                    border:1px solid #eee; border-radius:6px; font-size:12px;">
          <em>Sélectionne l’entité à déplacer, le nouveau parent et la date,
          puis clique sur « Sauvegarder ».</em>
        </div>

        <!-- Actions -->
        <div style="display:flex; gap:8px; margin-top:16px;">
          <button id="editor-save" type="button"
                  style="flex:1; background:#1976d2; color:white;
                         padding:10px; border-radius:4px; border:none;
                         cursor:pointer; font-weight:bold;">
            Sauvegarder
          </button>
          <button id="btn-editor-exit" type="button"
                  style="padding:10px; border-radius:4px; border:1px solid #ccc;
                         background:#fff; cursor:pointer;">
            Quitter
          </button>
        </div>
      </div>
  `;} else {
    // Autres opérations pas encore implémentées dans le détail
    bodyHTML = `
      <div id="editor-body">
        <div style="padding:8px; background:#fff3cd; border:1px solid #ffeeba; border-radius:6px; margin-bottom:8px;">
          Cette opération n’est pas encore détaillée dans l’interface.<br>
        </div>
        <button id="btn-editor-exit" type="button">Quitter</button>
      </div>
    `;
  }

  return `
    <div style="display:flex; flex-direction:column; gap:12px; font-size:14px;">

      <!-- 0) Choix de l'opération -->
      <div class="field">
        <label style="display:block; font-weight:600; margin-bottom:4px;">Que veux-tu faire ?</label>
        <select id="editor-operation" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:6px;">
          <option value="">Choisir une operation</option>
          <option value="edit-borders"       ${op==='edit-borders'?'selected':''}>Modifier uniquement les frontieres (ajouter/retirer des enfants)</option>
          <option value="edit-borders-dates" ${op==='edit-borders-dates'?'selected':''}>Modifier frontieres et periode (sans creer d'autres frontieres)</option>
          <option value="edit-borders-split" ${op==='edit-borders-split'?'selected':''}>Segmenter une periode puis modifier les frontieres</option>
          <option value="edit-dates"         ${op==='edit-dates'?'selected':''}>Modifier uniquement la periode (dates) d'une frontiere</option>
          <option value="create-entity"      ${op==='create-entity'?'selected':''}>Creer une nouvelle entite et definir sa zone</option>
          <option value="duplicate-entity"   ${op==='duplicate-entity'?'selected':''}>Dupliquer une entite sur une autre periode puis modifier ses frontieres</option>
          <option value="change-parent"      ${op==='change-parent'?'selected':''}>Changer le parent d'une entite sur une periode</option>
        </select>
        <small>Choisis d’abord une opération, les options utiles apparaîtront ensuite.</small>
      </div>

      ${bodyHTML}

    </div>
  `;
}



// Connecte les boutons du panneau d’édition
function attachEditorPanelEvents() {
  // --- 0) Gestion du choix de l'opération ---
  const opSelect = document.getElementById('editor-operation');
  if (opSelect) {
    // On positionne la valeur actuelle dans la liste (utile si on rerend)
    opSelect.value = editor.operation || '';

    opSelect.addEventListener('change', () => {
      editor.operation = opSelect.value || '';

      // Quand on change d'opération, on rerend tout le panneau éditeur
      if (sideContent) {
        sideContent.innerHTML = renderEditorPanel();
        attachEditorPanelEvents(); // on rebranche tous les écouteurs
        }
      });
    }

  const btnExit    = document.getElementById('btn-editor-exit');
  const parentInput= document.getElementById('editor-parent-input');
  const parentClear= document.getElementById('editor-parent-clear');
  const startInput = document.getElementById('editor-start');
  const endInput   = document.getElementById('editor-end');
  const granSel    = document.getElementById('editor-granularity');
  const msgBox     = document.getElementById('editor-msg');
  const lockBtn    = document.getElementById('editor-parent-lock');
  const parentView = document.getElementById('editor-parent-view');
  const btnPickChild = document.getElementById('btn-pick-child');
  const btnPickNewParent = document.getElementById('btn-pick-newparent');
  const newNameInput = document.getElementById('editor-new-entity-name');

  if (btnExit) btnExit.addEventListener('click', () => toggleEditorMode());

  // Verrouiller / déverrouiller la mère
  if (lockBtn) {
    lockBtn.addEventListener('click', () => {
      if (!editor.selectedParent) return;
      editor.parentLocked = !editor.parentLocked;
      lockBtn.textContent = editor.parentLocked ? 'Déverrouiller' : 'Verrouiller';
      renderSummary(msgBox);
    });
  }

  // Saisie manuelle de l’entité mère
  if (parentInput) {
    parentInput.addEventListener('input', () => {
      const name = (parentInput.value || '').trim();
      if (name.length > 0) {
        editor.selectedParent   = { id: null, name, category: null };
        editor.parentLevel      = null;
        editor.parentLocked     = false;
        editor.parentFrontiereId = null;   // <-- on ne sait pas quelle frontière exacte
        parentGeom              = null;
        if (parentLayer) {
          // on enlève le style spécial de l’ancienne mère
          const lvl = levelFromCategoryName(parentLayer.feature?.properties?.category_name);
          applyDefaultStyle(parentLayer, lvl);
          parentLayer = null;
        }
        if (parentView) {
          const span = parentView.querySelector('span');
          const btn  = parentView.querySelector('#editor-parent-lock');
          if (span) span.textContent = `${name} (saisi manuellement)`;
          if (btn)  btn.textContent  = 'Verrouiller';
        }
      } else {
        if (!editor.selectedParent && parentView) {
          const span = parentView.querySelector('span');
          const btn  = parentView.querySelector('#editor-parent-lock');
          if (span) span.textContent = 'Aucune (clique un polygone sur la carte)';
          if (btn)  btn.textContent  = 'Verrouiller';
          editor.parentLocked = false;
          editor.parentLevel  = null;
          parentGeom          = null;
          parentLayer         = null;
        }
      }
      renderSummary(msgBox);
    });
  }

  // Effacer la mère
  if (parentClear) {
    parentClear.addEventListener('click', () => {
      if (parentInput) parentInput.value = '';
      editor.selectedParent    = null;
      editor.parentLevel       = null;
      editor.parentLocked      = false;
      editor.parentFrontiereId = null;   // <-- reset ici aussi
      parentGeom               = null;
      if (parentLayer) {
        const lvl = levelFromCategoryName(parentLayer.feature?.properties?.category_name);
        applyDefaultStyle(parentLayer, lvl);
        parentLayer = null;
      }
      if (parentView) {
        const span = parentView.querySelector('span');
        const btn  = parentView.querySelector('#editor-parent-lock');
        if (span) span.textContent = 'Aucune (clique un polygone sur la carte)';
        if (btn)  btn.textContent  = 'Verrouiller';
      }
      renderSummary(msgBox);
    });
  }

  // Action
  document.querySelectorAll('input[name="editor-action"]').forEach(r => {
    r.addEventListener('change', (e) => {
      editor.action = e.target.value;
      renderSummary(msgBox);
    });
  });

  // Dates
  if (startInput) {
    startInput.addEventListener('change', () => {
      editor.startDate = startInput.value;
      renderSummary(msgBox);
    });
  }
  if (endInput) {
    endInput.addEventListener('change', () => {
      editor.endDate = endInput.value;
      renderSummary(msgBox);
    });
  }

  // Granularité
  if (granSel) {
    granSel.addEventListener('change', () => {
      editor.granularity = granSel.value;
      if (editor.operation === 'create-entity') {
        editor.newEntityCategory = granSel.value;
      }
      renderSummary(msgBox);
      updateVisibility();   // applique tout de suite l'affichage du niveau choisi
      scheduleRefresh();    // relance un fetch pour charger le niveau si besoin
    });
  }

  if (newNameInput) {
    newNameInput.addEventListener('input', () => {
      editor.newEntityName = newNameInput.value || '';
      renderSummary(msgBox);
    });
  }

  if (btnPickChild) {
    btnPickChild.addEventListener('click', () => {
      editor.pickingTarget = 'child';
      // On rafraîchit le panel pour mettre à jour les styles des boutons
      if (sideContent) {
        sideContent.innerHTML = renderEditorPanel();
        attachEditorPanelEvents();
      }
    });
  }

  if (btnPickNewParent) {
    btnPickNewParent.addEventListener('click', () => {
      editor.pickingTarget = 'newParent';
      if (sideContent) {
        sideContent.innerHTML = renderEditorPanel();
        attachEditorPanelEvents();
      }
    });
  }

  // Bouton "Prévisualiser..."
  const btnApply = document.getElementById('editor-apply');
  if (btnApply) {
    btnApply.addEventListener('click', () => {
      handleEditorApply(msgBox);
    });
  }



  // --- Bouton SAUVEGARDER EN BASE ---
    const btnSave = document.getElementById('editor-save');
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      if (!msgBox) return;

      const btnApply = document.getElementById('editor-apply');
      const btnExit  = document.getElementById('btn-editor-exit');

      // 0) Verrouiller l’UI pendant la sauvegarde
      const oldSaveText = btnSave.textContent;
      btnSave.disabled = true;
      if (btnApply) btnApply.disabled = true;
      if (btnExit)  btnExit.disabled  = true;
      btnSave.textContent = 'Sauvegarde en cours…';
      msgBox.innerHTML = `
        <div style="color:#333; margin-bottom:6px;"><strong>Enregistrement en base…</strong></div>
        <div style="font-size:12px;">Merci de patienter, la base recalcule la frontière du parent.</div>
      `;

      try {
        // 1) Construire le payload
        const needsGeometry = ['create-entity', 'duplicate-entity'].includes(editor.operation);
        const result = buildEditorPayload({ requireGeometry: needsGeometry });
        if (!result || !result.ok) {
          const problems = (result && result.problems) || ['Données incomplètes pour la sauvegarde.'];
          msgBox.innerHTML = `
            <div style="color:#b00020; margin-bottom:6px;"><strong>Impossible de sauvegarder :</strong></div>
            <ul style="margin-top:0; padding-left:18px; color:#b00020;">
              ${problems.map(p => `<li>${p}</li>`).join('')}
            </ul>
          `;
          return;
        }

        const payload = result.payload;

        const opsSupportees = ['edit-dates', 'edit-borders', 'edit-borders-dates', 'edit-borders-split', 'change-parent', 'create-entity', 'duplicate-entity'];
        if (!payload.operation || !opsSupportees.includes(payload.operation)) {
          msgBox.innerHTML = `
            <div style="color:#b00020; margin-bottom:6px;"><strong>Opération non encore supportée pour la sauvegarde.</strong></div>
            <div>Opérations supportées : ${opsSupportees.join(', ')}.</div>
          `;
          return;
}

        // 3) Appel API
        const resp = await fetch('/api/editor/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const raw = await resp.text();
        let data;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch (e) {
          throw new Error(raw || 'Reponse non JSON du serveur');
        }
        if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);


        msgBox.innerHTML = `
          <div style="color:#1b5e20; margin-bottom:6px;"><strong>Sauvegarde effectuée ✔</strong></div>
          <pre style="white-space:pre-wrap; font-size:12px;">${JSON.stringify(data, null, 2)}</pre>
        `;

        // ➜ Rechargement des couches pour refléter la base
        if (typeof MAJLayersMulti === 'function') {
          MAJLayersMulti();
        }
      } catch (err) {
        console.error(err);
        msgBox.innerHTML = `
          <div style="color:#b00020; margin-bottom:6px;"><strong>Erreur lors de la sauvegarde :</strong></div>
          <div>${err.message}</div>
        `;
      } finally {
        // 4) Déverrouiller l’UI
        btnSave.disabled = false;
        if (btnApply) btnApply.disabled = false;
        if (btnExit)  btnExit.disabled  = false;
        btnSave.textContent = oldSaveText;
      }
    });
  }




  // Sélection d’enfants
  const btnSelToggle = document.getElementById('editor-select-toggle');
  const btnSelClear  = document.getElementById('editor-select-clear');
  const selCount     = document.getElementById('editor-select-count');

  function refreshSelectionCounter() {
    const total = selectedAddIds.size + selectedRemoveIds.size;
    if (selCount) selCount.textContent = `${total} sélection(s)`;
  }
  refreshSelectionCounter();

  if (btnSelToggle) {
    btnSelToggle.addEventListener('click', () => {
      // Parent requis seulement pour les operations parent->enfants (pas pour create-entity)
      const parentRequiredOps = ['edit-borders', 'edit-borders-dates', 'edit-borders-split', 'edit-dates', 'duplicate-entity', 'change-parent'];
      const needParent = parentRequiredOps.includes(editor.operation);
      if (needParent && !editor.selectedParent) {
        if (msgBox) msgBox.innerHTML = `<div style="color:#b00020;"><strong>Choisis d'abord une entite mere.</strong></div>`;
        return;
      }
      if (needParent && !editor.parentLocked) {
        if (msgBox) msgBox.innerHTML = `<div style="color:#b00020;"><strong>Verrouille l'entite mere avant de selectionner les enfants.</strong></div>`;
        return;
      }
      selectionActive = !selectionActive;
      btnSelToggle.textContent = selectionActive ? 'Arreter selection' : 'Activer selection';
    });
  }


  if (btnSelClear) {
    btnSelClear.addEventListener('click', () => {
      for (const [id, lyr] of selectedLayers.entries()) {
        try {
          const lvl = levelFromCategoryName(lyr.feature?.properties?.category_name);
          applyDefaultStyle(lyr, lvl);
        } catch {}
      }
      selectedLayers.clear();
      selectedAddIds.clear();
      selectedRemoveIds.clear();
      refreshSelectionCounter();
    });
  }

  window.__editorRefreshSelectionCounter = refreshSelectionCounter;
  renderSummary(msgBox);
}


function renderSummary(msgBox, force=false) {
  if (!msgBox) return;

  const opNorm = editor.operation;

  const p = editor.selectedParent;
  const parentTxt = p ? `${p.name} ${p.id ? `(id ${p.id})` : ''}` : '- (non défini)';

  const s = editor.startDate ? new Date(editor.startDate) : null;
  const e = editor.endDate   ? new Date(editor.endDate)   : null;
  let problems = [];

  // Validation différente selon l'opération choisie
  if (opNorm === 'edit-borders-split' ||
      opNorm === 'edit-borders-dates' ||
      opNorm === 'edit-dates') {

    if (!editor.startDate) problems.push('Date de début manquante.');
    if (!editor.endDate)   problems.push('Date de fin manquante.');
    if (s && e && s > e)   problems.push('La date de début doit être ≤ la date de fin.');
    if (!p)                problems.push('Aucune entité mère / frontière sélectionnée (clique un polygone ou saisis un nom).');

  } else if (opNorm === 'edit-borders') {

    // En "modifier les frontières", les dates sont simplement informatives
    if (!p) problems.push('Aucune entité mère / frontière sélectionnée (clique un polygone ou saisis un nom).');
    if (s && e && s > e)   problems.push('La date de début doit être ≤ la date de fin.');

  } else if (opNorm === 'create-entity') {
    if (!editor.newEntityName) problems.push('Nom de la nouvelle entite manquant.');
    if (!editor.startDate) problems.push('Date de debut manquante.');
    if (!editor.endDate)   problems.push('Date de fin manquante.');
    if (s && e && s > e)   problems.push('La date de debut doit etre <= la date de fin.');

  } else {
    // Cas générique / autres opérations (pour l’instant)
    if (!p && editor.operation) {
      problems.push('Aucune entité sélectionnée pour cette opération.');
    }
  }


  let actionTxt;
  switch (opNorm) {
    case 'edit-borders':
      actionTxt = 'Modifier les frontières de cette entité sur la période choisie';
      break;
    case 'edit-borders-split':
      actionTxt = 'Segmenter la période, ajouter/retirer des enfants et supprimer les chevauchements';
      break;
    case 'edit-borders-dates':
      actionTxt = 'Modifier les frontières et la période sans créer de nouvelles frontières';
      break;
    case 'edit-dates':
      actionTxt = 'Modifier uniquement la période (dates) de cette frontière';
      break;
    case 'create-entity':
      actionTxt = 'Créer une nouvelle entité et définir sa zone';
      break;
    case 'duplicate-entity':
      actionTxt = 'Dupliquer une entité sur une autre période puis modifier ses frontières';
      break;
    case 'change-parent':
      actionTxt = 'Changer le parent de cette entité sur une période donnée';
      break;
    default:
      // Ancienne logique de repli si aucune opération n’est encore choisie
      actionTxt = (editor.action === 'modify')
        ? 'Mettre à jour les frontières pour la période actuelle'
        : 'Créer une nouvelle période de frontières';
  }

  const granTxt = ({
    countries:      'Countries (ADM0)',
    districts:      'Districts / Régions (ADM1)',
    municipalities: 'Municipalities / Communes (ADM2)'
  })[editor.granularity] || editor.granularity || '—';

  const opLabel = opNorm || '— (aucune opération choisie)';

  if (problems.length > 0) {
    msgBox.innerHTML = `
      <div style="color:#b00020; margin-bottom:6px;"><strong>À corriger :</strong></div>
      <ul style="margin-top:0; padding-left:18px; color:#b00020;">
        ${problems.map(p => `<li>${p}</li>`).join('')}
      </ul>
      <div style="margin-top:6px; opacity:0.85;">
        <strong>Résumé (brouillon) :</strong><br>
        Opération : ${opLabel}<br>
        Entité / frontière : ${parentTxt}<br>
        Période : ${editor.startDate || '—'} → ${editor.endDate || '—'}<br>
        Granularité (si applicable) : ${granTxt}
      </div>
    `;
    return;
  }

  // Tout est cohérent → petit résumé "vert"
  msgBox.innerHTML = `
    <div style="color:#1b5e20; margin-bottom:6px;"><strong>Paramètres prêts ✔</strong></div>
    <div><strong>Opération :</strong> ${opLabel}</div>
    <div><strong>Action :</strong> ${actionTxt}</div>
    <div><strong>Entité / frontière :</strong> ${parentTxt}</div>
    <div><strong>Période :</strong> ${editor.startDate || '—'} → ${editor.endDate || '—'}</div>
    <div><strong>Granularité (si applicable) :</strong> ${granTxt}</div>
    <div style="margin-top:6px; opacity:0.85;">
      Étape suivante : le bouton "Prévisualiser" utilisera ces informations pour construire la modification logique
      (puis on branchera la sauvegarde sur la base).
    </div>
  `;
}



// Détermine le "niveau" (countries/districts/municipalities) d'une feature à partir de category_name
function levelFromCategoryName(categoryName) {
  const s = String(categoryName || '').toLowerCase();
  if (/adm0|country|countries|pays/.test(s)) return 'countries';
  if (/adm1|district|region|state/.test(s))  return 'districts';
  if (/adm2|municipal|commune|county/.test(s)) return 'municipalities';
  return null;
}

// Style de sélection (surbrillance)
function styleSelected() {
  return { color: '#2e7d32', weight: 2, fillOpacity: 0.25 };
}

// Restaure le style par défaut selon le niveau + zoom
function applyDefaultStyle(layer, level) {
  const z = map.getZoom();
  if (level === 'countries')      layer.setStyle(styleCountries(z));
  else if (level === 'districts') layer.setStyle(styleDistricts(z));
  else if (level === 'municipalities') layer.setStyle(styleMunicipalities(z));
}

// Style de la mère (frontière principale)
function styleParent() {
  return { color: '#1976d2', weight: 3, fillOpacity: 0.08 };
}

// Style d'ajout (en dehors de la mère)
function styleAdd() {
  return { color: '#2e7d32', weight: 2, fillOpacity: 0.25 };
}

// Style de retrait (à l'intérieur de la mère)
function styleRemove() {
  return { color: '#c62828', weight: 2, fillOpacity: 0.25 };
}

function classifyChildSelection(feature) {
  // Si pas de mère ou pas de géométrie, on considère que c’est un ajout
  if (!parentGeom || typeof turf === 'undefined') return 'add';
  try {
    const childGeom = feature.geometry;
    const center = turf.centroid(childGeom);
    const inside = turf.booleanPointInPolygon(center, parentGeom);
    return inside ? 'remove' : 'add';
  } catch {
    return 'add';
  }
}

// Petit helper pour afficher du JSON proprement dans un <pre>
function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[c]));
}

// Construit le "plan de modification" à partir de l'état de l'éditeur
function buildEditorPayload(options = {}) {
  const { requireGeometry = false } = options; 

  const op      = editor.operation;
  const parent  = editor.selectedParent; // Pour change-parent, c'est l'enfant
  const s       = editor.startDate ? new Date(editor.startDate) : null;
  const e       = editor.endDate   ? new Date(editor.endDate)   : null;
  const problems = [];

  if (!op) {
    problems.push('Choisis d’abord une opération dans la liste "Que veux-tu faire ?".');
    return { ok: false, problems };
  }

  // ============================================================
  // 1. CHANGE-PARENT (PLACÉ EN PREMIER POUR ÉVITER LE BUG)
  // ============================================================
  if (op === 'change-parent') {
    const refDate = document.getElementById('editor-ref-date')?.value;
    
    // Validation
    if (!parent) problems.push('1. Sélectionne l’entité à déplacer (Enfant) sur la carte.');
    if (!editor.newParent) problems.push('2. Sélectionne le Nouveau Parent (Destination) sur la carte.');
    if (!refDate) problems.push('3. Date de référence manquante.');
    
    // Vérification logique
    if (parent && editor.newParent && parent.id === editor.newParent.id) {
        problems.push('L’enfant et le nouveau parent ne peuvent pas être la même entité !');
    }

    if (problems.length > 0) return { ok: false, problems };

    const payload = {
      operation: op,
      child: {
        entityCategoryId: parent.entityCategoryId || parent.id,
        frontiereId:      editor.parentFrontiereId,
        name:             parent.name
      },
      newParent: {
        name: editor.newParent.name 
      },
      dateReference: refDate,
      // On envoie la date actuelle de la carte pour que le serveur sache quel lien supprimer
      currentMapDate: date.toISOString().split('T')[0] 
    };

    return { ok: true, payload };
  }

  // --- 2. CREATE-ENTITY ---
  if (op === 'create-entity') {
    if (!editor.newEntityName) problems.push('Nom de la nouvelle entitŴ manquant.');
    if (!editor.startDate) problems.push('Date de dŴbut manquante.');
    if (!editor.endDate)   problems.push('Date de fin manquante.');
    if (s && e && s > e) problems.push('La date de dŴbut doit Ŷtre Ŵ la date de fin.');
    if (op === 'edit-borders-split' && selectedAddIds.size === 0 && selectedRemoveIds.size === 0) {
      problems.push("Aucune modification d'enfants (add/remove) demandŴe.");
    }
    if (requireGeometry && !editor.newGeometry) {
      problems.push('Lance la prŴvisualisation pour calculer la gŴomŴtrie.');
    }
    if (problems.length > 0) return { ok: false, problems };

    const payload = {
      operation: op,
      parent: parent ? {
        id:               parent.id,
        entityCategoryId: parent.entityCategoryId || null,
        name:             parent.name,
        category:         parent.category,
        level:            editor.parentLevel,
        frontiereId:      editor.parentFrontiereId
      } : null,
      newEntity: {
        name: editor.newEntityName,
        category: editor.newEntityCategory || editor.granularity
      },
      period: { start: editor.startDate, end: editor.endDate },
      granularity: editor.granularity,
      selections: { add: Array.from(selectedAddIds), remove: Array.from(selectedRemoveIds) },
      geometry: editor.newGeometry || null
    };
    return { ok: true, payload };
  }


  if (op === 'duplicate-entity') {
    if (!parent) problems.push('Aucune entité è dupliquer sélectionnée.');
    if (!editor.startDate) problems.push('Date de début manquante.');
    if (!editor.endDate)   problems.push('Date de fin manquante.');
    if (s && e && s > e) problems.push('La date de début doit être à la date de fin.');
    if (op === 'edit-borders-split' && selectedAddIds.size === 0 && selectedRemoveIds.size === 0) {
      problems.push('Aucune modification d\'enfants (add/remove) demandée.');
    }
    if (requireGeometry && !editor.newGeometry) {
      problems.push('Prévisualise pour calculer la géométrie copiée.');
    }
    if (problems.length > 0) return { ok: false, problems };

    const payload = {
      operation: op,
      parent: {
        id:               parent.id,
        entityCategoryId: parent.entityCategoryId || null,
        name:             parent.name,
        category:         parent.category,
        level:            editor.parentLevel,
        frontiereId:      editor.parentFrontiereId
      },
      period: { start: editor.startDate, end: editor.endDate },
      granularity: editor.granularity,
      selections: { add: Array.from(selectedAddIds), remove: Array.from(selectedRemoveIds) },
      geometry: editor.newGeometry || null
    };
    return { ok: true, payload };
  }

  if (op === 'edit-borders' || op === 'edit-borders-dates' || op === 'edit-borders-split') {
    if (!parent) problems.push('Aucune entité mère sélectionnée.');
    if (requireGeometry && !editor.newGeometry) {
      problems.push('Tu dois d’abord cliquer sur "Prévisualiser" pour calculer la nouvelle frontière.');
    }
    if (op === 'edit-borders-dates' || op === 'edit-borders-split') {
      if (!editor.startDate) problems.push('Date de début manquante.');
      if (!editor.endDate)   problems.push('Date de fin manquante.');
    }
    if (s && e && s > e) problems.push('La date de début doit être ≤ la date de fin.');
    if (op === 'edit-borders-split' && selectedAddIds.size === 0 && selectedRemoveIds.size === 0) {
      problems.push('Aucune modification d\'enfants (add/remove) demandée.');
    }

    if (problems.length > 0) return { ok: false, problems };

    const payload = {
      operation: op,
      parent: {
        id:               parent.id,
        entityCategoryId: parent.entityCategoryId || null,
        name:             parent.name,
        category:         parent.category,
        level:            editor.parentLevel,
        frontiereId:      editor.parentFrontiereId
      },
      period: { start: editor.startDate || null, end: editor.endDate || null },
      granularity: editor.granularity,
      selections: { add: Array.from(selectedAddIds), remove: Array.from(selectedRemoveIds) }
    };
    return { ok: true, payload };
  }

  // --- 3. EDIT-DATES ---
  if (op === 'edit-dates') {
    if (!parent) problems.push('Aucune entité / frontière sélectionnée.');
    if (!editor.startDate) problems.push('Date de début manquante.');
    if (!editor.endDate)   problems.push('Date de fin manquante.');

    if (problems.length > 0) return { ok: false, problems };

    const payload = {
      operation: op,
      parent: {
        id:         parent.id,
        name:       parent.name,
        category:   parent.category,
        level:      editor.parentLevel,
        frontiereId: editor.parentFrontiereId
      },
      period: { start: editor.startDate, end: editor.endDate }
    };
    return { ok: true, payload };
  }

  // --- 4. CATCH-ALL (SI AUCUNE OPÉRATION CI-DESSUS N'A MATCHÉ) ---
  problems.push('Cette opération n’est pas encore supportée par la prévisualisation.');
  return { ok: false, problems };
}

// Gère le clic sur "Prévisualiser..."
function handleEditorApply(msgBox) {
  // En prévisualisation on ne bloque jamais sur la géométrie : elle est justement calculée après.
  const result = buildEditorPayload({ requireGeometry: false });
  if (!result) return;

  if (!result.ok) {
    const problems = result.problems || [];
    msgBox.innerHTML = `
      <div style="color:#b00020; margin-bottom:6px;"><strong>Impossible de prévisualiser :</strong></div>
      <ul style="margin-top:0; padding-left:18px; color:#b00020;">
        ${problems.map(p => `<li>${p}</li>`).join('')}
      </ul>
    `;
    return;
  }

    const payload = result.payload;

  // Affichage dans la sidebar
  msgBox.innerHTML = `
    <div style="color:#1b5e20; margin-bottom:6px;"><strong>Aperçu logique prêt ✔</strong></div>
    <div style="margin-bottom:6px;">
      Voici le "plan" de modification qui pourrait être envoyé au serveur :
    </div>
    <pre style="white-space:pre-wrap; max-height:220px; overflow:auto; background:#f5f5f5; padding:8px; border-radius:4px;">
${escapeHTML(JSON.stringify(payload, null, 2))}
    </pre>
    <small>
      Tu vois à la fois le plan logique ci-dessus et, sur la carte,
      la nouvelle frontière de l’entité mère en orange.
    </small>
  `;

  console.log('EDITOR PAYLOAD', payload);

  // ➜ Prévisualisation géométrique pour les opérations sur les frontières
  if (payload.operation === 'edit-borders' || payload.operation === 'edit-borders-dates' || payload.operation === 'edit-borders-split' || payload.operation === 'duplicate-entity') {
    previewParentGeometryBorders();
  } else if (payload.operation === 'create-entity') {
    previewCreateEntityGeometry();
  } else {
    // Pour les autres opérations, on nettoie juste le draft
    if (draftGroup) draftGroup.clearLayers();
  }
}


// Transforme une géométrie brute en Feature GeoJSON
function geomToFeature(geom) {
  return {
    type: 'Feature',
    properties: {},
    geometry: geom
  };
}

// Prévisualisation de la nouvelle frontière de la mère
function previewParentGeometryBorders() {
  if (!draftGroup || !parentGeom || typeof turf === 'undefined') {
    console.warn('Prévisualisation impossible (draftGroup/parentGeom/turf manquant).');
    return;
  }

  // On nettoie les anciens drafts
  draftGroup.clearLayers();

  // 1) Point de départ : géométrie actuelle de la mère
  let resultFeature = geomToFeature(parentGeom);

  // 2) Ajouts : union avec les enfants "verts"
  for (const id of selectedAddIds) {
    const layer = selectedLayers.get(id);
    if (!layer || !layer.feature || !layer.feature.geometry) continue;

    try {
      const childFeat = geomToFeature(layer.feature.geometry);
      const unioned = turf.union(resultFeature, childFeat);
      if (unioned) resultFeature = unioned;
    } catch (e) {
      console.error('Erreur union enfant', e);
    }
  }

  // 3) Retraits : différence avec les enfants "rouges"
  for (const id of selectedRemoveIds) {
    const layer = selectedLayers.get(id);
    if (!layer || !layer.feature || !layer.feature.geometry) continue;

    try {
      const childFeat = geomToFeature(layer.feature.geometry);
      const diff = turf.difference(resultFeature, childFeat);
      if (diff) resultFeature = diff; // si diff=null on garde l’ancien
    } catch (e) {
      console.error('Erreur difference enfant', e);
    }
  }

  // 4) Affichage de la nouvelle frontière en orange
  draftGroup.clearLayers();

  L.geoJSON(resultFeature, {
    style: {
      color: '#ff9800',
      weight: 2,
      fillOpacity: 0.15
    },
    interactive: false   // la preview ne doit pas capter les clics
  }).addTo(draftGroup);

  // 5) Stocker la géométrie pour la sauvegarde
  editor.newGeometry =
    resultFeature && resultFeature.geometry ? resultFeature.geometry : null;
}

// Prévisualisation spécifique à la création d'entité
function previewCreateEntityGeometry() {
  if (!draftGroup || typeof turf === 'undefined') {
    console.warn('Prévisualisation impossible (draftGroup/turf manquant).');
    return;
  }

  if (selectedAddIds.size === 0 && selectedRemoveIds.size === 0) {
    if (draftGroup) draftGroup.clearLayers();
    console.warn('Aucune sélection pour construire la nouvelle frontière.');
    return;
  }

  draftGroup.clearLayers();

  let resultFeature = null;

  for (const id of selectedAddIds) {
    const layer = selectedLayers.get(id);
    if (!layer || !layer.feature || !layer.feature.geometry) continue;
    const childFeat = geomToFeature(layer.feature.geometry);
    try {
      resultFeature = resultFeature ? turf.union(resultFeature, childFeat) : childFeat;
    } catch (e) {
      console.error('Erreur union enfant (create-entity)', e);
    }
  }

  if (!resultFeature) return;

  for (const id of selectedRemoveIds) {
    const layer = selectedLayers.get(id);
    if (!layer || !layer.feature || !layer.feature.geometry) continue;
    try {
      const diff = turf.difference(resultFeature, geomToFeature(layer.feature.geometry));
      if (diff) resultFeature = diff;
    } catch (e) {
      console.error('Erreur difference enfant (create-entity)', e);
    }
  }

  draftGroup.clearLayers();
  L.geoJSON(resultFeature, {
    style: { color: '#ff9800', weight: 2, fillOpacity: 0.15 },
    interactive: false
  }).addTo(draftGroup);

  editor.newGeometry = resultFeature && resultFeature.geometry ? resultFeature.geometry : null;
}

function resetEditorState() {
  editor.operation        = 'edit-borders-dates';
  editor.selectedParent   = null;
  editor.newParent        = null;    // ★ Reset
  editor.pickingTarget    = 'child'; // ★ Reset
  editor.action           = 'modify';
  editor.startDate        = date.toISOString().split('T')[0];
  editor.endDate          = date.toISOString().split('T')[0];
  editor.granularity      = 'districts';
  editor.parentLocked     = false;
  editor.parentLevel      = null;
  editor.parentFrontiereId = null;
  editor.newGeometry      = null;
  editor.newEntityName    = '';
  editor.newEntityCategory = 'districts';

  selectionActive = false;
  selectedAddIds.clear();
  selectedRemoveIds.clear();
  selectedLayers.clear();
  parentLayer = null;
  parentGeom  = null;

  if (draftGroup) draftGroup.clearLayers();
}
