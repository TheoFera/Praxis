/*à faire : 
- Faire un bouton play/pause pour voir le temps défiler tout seul
- Empêcher de pouvoir aller dans les dates après la date du jour et avant -99 000 avant JC => OK
- Ajouter d'autres factions mineures qui ont constituées la France => nécessite de réussir à gérer + d'un pays
- Intégrer les conflits (events)

- intégrer de nouvelles données à la slide bar :
    -> Mode de production
    -> Créer des graphiques en javascript
    -> Lecteur de musique
    -> Livres de l'époque

- intégrer d'autres données au  Geojson :
    -> Avant 1713
*/

////////////// initialisation des boutons ////////////
////Side bar 
const toggleButton = document.getElementById('toggle-button');
const sideBar = document.getElementById('side-bar');

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

    // 2) Districts si z >= DISTRICT_Z
    if (z >= DISTRICT_Z) {
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

    // 3) Municipalities si z >= MUNIC_Z
    if (z >= MUNIC_Z) {
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
  layer.on('click', () => {
    sideBar.classList.add('active');

    // Nom prioritaire : entity_name (depuis la BDD).
    // Fallback éventuel : properties.name (si présent dans le GeoJSON).
    const entityName   = feature.properties?.entity_name ?? 'Nom inconnu';
    const categoryName = feature.properties?.category_name ?? 'Catégorie inconnue';
    
    console.log('Feature au clic →', feature.properties);

    document.getElementById('titre').innerText = entityName;
    document.getElementById('sous-titre').innerText = categoryName;

    // (Optionnel) Nettoyer l'image/bannière si tu n'en as pas ici :
    // document.getElementById('properties-img').src = '';
  });
}

function updateVisibility(){
  const z = map.getZoom();

  // Visibilité automatique selon le zoom (l’utilisateur peut toujours décocher dans le control)
  if (!map.hasLayer(groupCountries)) map.addLayer(groupCountries); // Countries toujours affichés par défaut
  if (z >= DISTRICT_Z) { if (!map.hasLayer(groupDistricts)) map.addLayer(groupDistricts); }
  else                 { if (map.hasLayer(groupDistricts))  map.removeLayer(groupDistricts); }

  if (z >= MUNIC_Z)    { if (!map.hasLayer(groupMunicipalities)) map.addLayer(groupMunicipalities); }
  else                 { if (map.hasLayer(groupMunicipalities))  map.removeLayer(groupMunicipalities); }

  // Priorité des clics (click-through via CSS pointer-events sur les panes)
  const countriesPane      = map.getPane('countries');
  const districtsPane      = map.getPane('districts');
  const municipalitiesPane = map.getPane('municipalities');

  // Règle simple : quand un niveau plus fin est visible, les niveaux en dessous passent en "pointer-events:none"
  countriesPane.style.pointerEvents      = (z < DISTRICT_Z) ? 'auto' : 'none';
  districtsPane.style.pointerEvents      = (z >= DISTRICT_Z && z < MUNIC_Z) ? 'auto' : (z >= MUNIC_Z ? 'none' : 'auto');
  municipalitiesPane.style.pointerEvents = (z >= MUNIC_Z) ? 'auto' : 'none';
}

// À chaque fin de zoom : on rafraîchit styles + visibilité/clics
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => MAJLayersMulti(), 300);
}
map.on('zoomend', () => {
  // restyle rapide
  const z = map.getZoom();
  [groupCountries, groupDistricts, groupMunicipalities].forEach(g=>{
    g.eachLayer(l => { if (l.setStyle && l.options && typeof l.options.style === 'function') {
      l.setStyle(l.options.style());
    }});
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
/*
function montre(){
    sideBar.classList.add('active');
    ChangeData(date, codesoc);
}*/
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