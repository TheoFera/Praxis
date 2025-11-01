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
    maxZoom: 8,
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

// en haut, après la création de la map
var layersControl = L.control.layers(null, Filtres, {position: 'bottomright'}).addTo(map);

var codesoc = ""; // contiendra le code de la société sélectionnée

////// Nouveau : contiendra la FeatureCollection renvoyée par l'API
var pays = { type: 'FeatureCollection', features: [] };

// --- Style appliqué au GeoJSON ---
var Paysstyle = {
    "color": "#C0C0C0",
    "weight": 1,
    "opacity": 1,
    "fillOpacity": 0.1,
};

// --- Définition des couches de filtres ---
var Filtrepays = L.layerGroup();      // contiendra les polygones des pays
var Layername = "Pays";               // nom utilisé dans le contrôle de couche
var Filtres = {
    "Pays": Filtrepays,
    //"Mode de production": FiltreMOP
};

//Recharge le layer à chaque changement de date
//  ol: objetstockantlesdifférentslayergroup (Filtres) ; lg: layergroup (Filtrepays) ; ls: layergroupstyle (paysstyle)
async function MAJLayers(ol, lg, ls){
    // 1) Date au format YYYY-MM-DD pour l'API
    const dateISO = date.toISOString().split('T')[0];

    // 2) Récupère les frontières auprès de l’API Express
    //    - On attend la réponse (await)
    //    - On stocke tout dans la variable globale "pays"
    try {
        const resp = await fetch(`/api/frontieres?date=${dateISO}`);
        if (!resp.ok) {
            console.error('API /api/frontieres a répondu avec une erreur', resp.status);
            return;
        }
        pays = await resp.json(); // FeatureCollection reçu du serveur
    } catch (e) {
        console.error('Impossible de contacter /api/frontieres :', e);
        return; // on n'affiche rien si erreur réseau
    }

    // 3) Nettoie le LayerGroup et le contrôle de couches
    lg.clearLayers();
    layersControl.removeLayer(lg);

    // 4) Ajoute la couche GeoJSON sur la carte
    L.geoJSON(pays, {
        style: ls,
        filter: function (feature, layer) {
            if (!feature.geometry || !feature.geometry.when) return false;

            const [startStr, endStr] = feature.geometry.when;
            const startOk = !startStr || new Date(startStr) <= date; // si pas de début -> ok
            const endOk   = !endStr   || new Date(endStr)   >= date; // si pas de fin   -> ok

            return startOk && endOk;
        },
        onEachFeature: onEachFeature,
    }).addTo(lg);

    // 5) Affiche le LayerGroup actualisé
    layersControl.addOverlay(lg, Layername);
    lg.addTo(map);
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
MAJLayers(Filtres, Filtrepays, Paysstyle); //Change les contours quand la date change
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