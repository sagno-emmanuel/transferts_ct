"use strict";
/* =====================================================================
   Transferts CT — version 4.2 — CORE (socle commun)
   =====================================================================
   Rôle : ce fichier est chargé EN PREMIER par templates/transferts/index.html.
   Il ne contient aucun écran : il fournit tout ce dont les autres modules
   (shell.js, rotations.js, pointage.js, ordres.js, suivi.js) ont besoin :

     1. Référentiels métier (prestataires, sites, jalons, opérations, flotte).
     2. Outils génériques (échappement HTML, dates, formatage, toast).
     3. Stockage local (localStorage) et état applicatif global `S`.
     4. Règles métier partagées (facturation, statut d'une rotation, jalons).
     5. Appels RPC vers Django et moteur de synchronisation hors ligne.
     6. Gestion des photos (IndexedDB côté navigateur, puis fichier média Django).

   Modèle de données hors ligne
   ----------------------------
   `S.data[type][id]`   : les enregistrements connus, un objet par type.
   `S.outbox`           : les identifiants modifiés localement, en attente d'envoi.
   `S.lastSeq` / `S.seen`: position de lecture du journal serveur (tct_pull).
   Toute écriture passe par save() / remove() / saveSettings() / saveRef(),
   qui persistent localement, mettent à jour la file d'envoi et planifient
   une synchronisation. Aucun module ne doit écrire `S.data` directement.

   Flux de synchronisation (toutes les 5 s si une session est ouverte)
   --------------------------------------------------------------------
   syncNow() = uploadPhotos() -> push() -> pull()
     push : envoie la file `S.outbox` par lots de 40 (tct_push).
     pull : relit le journal serveur depuis `S.lastSeq` (tct_pull).
   En cas d'absence de réseau, tout reste en local et repart plus tard.
   ===================================================================== */
const PHOTO_BUCKET = "tct-photos";
const VERSION = "4.2";

/* =====================================================================
   1. RÉFÉRENTIELS
   Valeurs de repli utilisées au premier lancement. Ensuite, la source de
   vérité est l'enregistrement « __referentiels__ » de la base, modifiable
   dans l'écran Réglages (voir applyRef/currentRef plus bas).
   ===================================================================== */
const PRESTATAIRES = ["AGL", "EDT", "GOS", "GSL", "COPRELOG", "IKT", "NLS"];
const SITES = ["TAC (Conakry Terminal)", "PSK (Kagbélen)", "Parc Burkina", "Parc Kidal"];
const SITE_KEYS = { PSK: "PSK (Kagbélen)", BU: "Parc Burkina", KI: "Parc Kidal" };
const ARMATEURS = ["MSC", "MAERSK", "CMA CGM", "HAPAG-LLOYD", "ONE", "COSCO", "Autre"];
const OPERATIONS = [
  "Boucle Complète (TAC → PSK, retour vide)",
  "Boucle Simple (PSK → TAC, vide)",
  "Transfert Intramuros BU (Parc Burkina → TAC, vide)",
  "Transfert de pleins Burkina (Parc Burkina → TAC, plein)",
  "Transfert Intramuros KIDAL (Parc Kidal → TAC, vide)",
  "Transfert Roro (TAC → PSK)",
  "Transfert Intramuros PSK (PSK → PSK)"
];
// Opérations qui sortent un conteneur PLEIN du terminal : la sortie du
// terminal y compte comme un objectif atteint (voir vyCompteObj).
const OPS_PLEIN_SORTIE = [OPERATIONS[0], OPERATIONS[5]];
const JALONS = [
  "Présentation du camion",
  "Entrée terminal",
  "Réception du coupon",
  "Début de chargement",
  "Fin de chargement",
  "Sortie du terminal",
  "Arrivée à Kagbélen",
  "Déchargement PSK",
  "Chargement du vide",
  "Sortie de Kagbélen",
  "Arrivée à CT",
  "Déchargement du vide à CT"
];
// Propriétaire de chaque jalon : détermine qui peut le valider
// (presta = prestataire, CT = agent CT, PSK = agent PSK).
const JALON_OWNER = {
  "Présentation du camion": "presta",
  "Entrée terminal": "presta",
  "Réception du coupon": "CT",
  "Début de chargement": "CT",
  "Fin de chargement": "CT",
  "Sortie du terminal": "CT",
  "Arrivée à Kagbélen": "PSK",
  "Déchargement PSK": "PSK",
  "Chargement du vide": "PSK",
  "Sortie de Kagbélen": "PSK",
  "Arrivée à CT": "presta",
  "Déchargement du vide à CT": "presta"
};
const OWNER_LABEL = { presta: "Prestataire", CT: "Agent CT", PSK: "Agent PSK" };
const JALON_SORTIE = "Sortie du terminal",
  JALON_KAG = "Arrivée à Kagbélen";
const INCIDENT_TYPES = [
  "Panne mécanique",
  "Crevaison",
  "Panne électrique",
  "Accident / collision",
  "Immobilisation douane",
  "Autre"
];
const MOTIFS_RETRAIT = ["Maintenance", "Panne", "Crevaison", "Accident", "Contrôle technique", "Autre"];
// Raisons saisies quand un camion ne sort pas du terminal.
const RAISONS_NONSORTIE = [
  "Sorti",
  "Non sorti — pas de chargement",
  "Non sorti — camion indisponible",
  "Non sorti — retard signature",
  "Non sorti — autre"
];
// Flotte initiale par prestataire (repli : voir la note ci-dessous).
const FLEET = {
  AGL: [
    "BL-5433-02",
    "BL-5392-02",
    "BL-5393-02",
    "BL-5462-02",
    "BL-5494-02",
    "BL-5398-02",
    "BL-5488-02",
    "BL-5439-02",
    "BL-5480-02",
    "BL-5496-02",
    "BL-5474-02",
    "BL-5371-02",
    "BL-5388-02",
    "BL-5427-02",
    "BL-5443-02",
    "BL-5425-02",
    "BL-5380-02",
    "BL-5472-02",
    "BL-5421-02",
    "BL-5435-02",
    "BL-5484-02",
    "BL-5508-02",
    "BL-5475-02",
    "BL-5513-02",
    "BL-5418-02",
    "BL-5468-02",
    "BL-5402-02",
    "BL-5504-02",
    "BL-5518-02"
  ],
  EDT: [
    "BA6898",
    "BA6912",
    "BA6890",
    "BA6885",
    "BA6904",
    "BA6894",
    "BA6901",
    "BA6909",
    "BE2601",
    "BK6339",
    "BG5302",
    "BG5293",
    "AX0843",
    "AX0839",
    "BJ3617",
    "BJ3613",
    "BH2489"
  ],
  GOS: [
    "BJ4726",
    "BC6056",
    "BC6057",
    "BC6058",
    "BI0132",
    "BE2956",
    "BG0937",
    "BH2293",
    "BH2304",
    "BF5799",
    "BB9364",
    "BB9365",
    "BB9366",
    "BB2084",
    "BI0158",
    "RC3238",
    "BI0154",
    "BI0153",
    "BG0924"
  ],
  COPRELOG: [
    "BN-2052-02",
    "BD-2231-02",
    "BD-2232-02",
    "BD-2234-02",
    "BD-3753-02",
    "BK-1119-02",
    "BC-8234-02",
    "AW-9714-02",
    "AY-6839-02",
    "BE-6977-02",
    "BE-6978-02",
    "BI-5398-02",
    "BI-3888-02",
    "BI-3931-02",
    "BI-3934-02",
    "BI-4032-02",
    "BI-4072-02",
    "BI-4083-02",
    "BK-4935-02",
    "BL-0061-02",
    "BK-9817-02"
  ],
  IKT: [
    "AH3224",
    "AH3231",
    "AF7757",
    "AL3915",
    "AN8309",
    "BA4473",
    "BF1344",
    "BF1355",
    "RC3943",
    "RC5467",
    "BL3592",
    "BL3588",
    "BL3616"
  ],
  GSL: [
    "BA7275-02",
    "BA7278-02",
    "BA7279-02",
    "BA7314-02",
    "BA7293-02",
    "BA7308-02",
    "BA7286-02",
    "BA7298-02",
    "BA7276-02",
    "BA7306-02"
  ],
  NLS: ["BL-4236-02", "BL-4180-02", "BL-4182-02", "BA-0520-02", "BA-0521-02"]
};
// Les listes PRESTATAIRES et FLEET ci-dessus ne servent qu'au premier lancement :
// la version en vigueur est le référentiel « __referentiels__ » de la base, modifiable dans Réglages.
/**
 * Remplace les référentiels en mémoire par ceux reçus du serveur.
 * La comparaison se fait sur place : les objets PRESTATAIRES/FLEET sont
 * partagés par référence avec ROLES, on ne peut donc pas les réassigner.
 * @param {{prestataires: string[], flotte: Object<string, string[]>}} d
 * @returns {boolean} false si `d` est vide ou invalide (on garde le repli).
 */
function applyRef(d) {
  if (!d || !Array.isArray(d.prestataires) || !d.prestataires.length) return false;
  PRESTATAIRES.length = 0;
  d.prestataires.forEach((p) => PRESTATAIRES.push(p));
  Object.keys(FLEET).forEach((k) => delete FLEET[k]);
  Object.assign(FLEET, d.flotte || {});
  return true;
}
/**
 * Copie profonde des référentiels courants, prête à être envoyée au serveur
 * (tct_push) ou stockée dans localStorage sous la clé « ref ».
 */
function currentRef() {
  return { prestataires: PRESTATAIRES.slice(), flotte: JSON.parse(JSON.stringify(FLEET)) };
}
// Description des accès : libellé affiché, icône, et entités autorisées
// pour les rôles rattachés à un site ou à un prestataire.
const ROLES = {
  ct: { label: "Donneur d'ordre (CT)", icon: "🧭", desc: "Commander, affecter, notifier, superviser." },
  agent: {
    label: "Agent terrain",
    icon: "🦺",
    desc: "Jalons, convois et pointage à ton site.",
    entities: ["CT", "PSK"]
  },
  hse: { label: "HSE", icon: "⛑️", desc: "TBM, départs de convoi et incidents." },
  site: {
    label: "Chef de site",
    icon: "📍",
    desc: "Flux prévus et contresignature à ton site.",
    entities: ["PSK", "BU", "KI"]
  },
  presta: {
    label: "Prestataire",
    icon: "🚚",
    desc: "Flotte du jour, ordres reçus, rotations.",
    entities: PRESTATAIRES
  },
  pointeur: {
    label: "Agent terrain prestataire",
    icon: "📦",
    desc: "Pointage des conteneurs pour ta société.",
    entities: PRESTATAIRES
  }
};
const AGENT_SITE_LABEL = { CT: "Conakry Terminal (TAC)", PSK: "Port Sec Kagbélen" };
const TYPES = ["programmes", "flotte", "retraits", "voyages", "pointages", "convois"];

/* =====================================================================
   2. OUTILS GÉNÉRIQUES
   Petites fonctions utilitaires sans dépendance à l'état applicatif.
   ===================================================================== */

/** Raccourci de document.getElementById. */
const $ = (id) => document.getElementById(id);

/**
 * Échappe une valeur pour l'insérer dans du HTML (texte ou attribut).
 * À utiliser SYSTÉMATIQUEMENT autour des données saisies par l'utilisateur,
 * car presque tous les écrans construisent leur HTML par template string.
 */
function esc(s) {
  return (s == null ? "" : String(s)).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
/** Identifiant local unique et triable dans le temps (base 36 + aléa). */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
/** Horodatage courant au format ISO 8601 (UTC), celui stocké en base. */
function nowISO() {
  return new Date().toISOString();
}
/**
 * Journée locale d'une date, au format « AAAA-MM-JJ ».
 * C'est la clé de regroupement de tous les écrans (programme du jour, flotte…).
 */
function localDay(d) {
  d = d || new Date();
  const z = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
}
/** Journée locale courante « AAAA-MM-JJ ». */
function today() {
  return localDay();
}

/** Journée locale (AAAA-MM-JJ) d'un horodatage ISO, ou "" si vide. */
function dayOfISO(iso) {
  return iso ? localDay(new Date(iso)) : "";
}
/** Heure « HH:MM » d'un horodatage ISO (affichage compact). */
function hm(iso) {
  return iso ? new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
}
/** Date et heure « JJ/MM HH:MM » d'un horodatage ISO. */
function dhm(iso) {
  return iso
    ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
}
/**
 * Convertit une journée « AAAA-MM-JJ » et une heure « HH:MM » (heure locale)
 * en horodatage ISO. Renvoie "" si l'heure n'est pas renseignée.
 */
function isoAt(day, hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":");
  const d = new Date(day + "T00:00:00");
  d.setHours(+h, +m, 0, 0);
  return d.toISOString();
}
/**
 * Comme isoAt(), mais décale au lendemain si l'heure obtenue est antérieure
 * de plus d'une heure au jalon précédent : évite un « 23:50 puis 00:10 »
 * interprété à l'envers lors d'une saisie après minuit.
 */
function isoAfter(day, hhmm, prevIso) {
  let iso = isoAt(day, hhmm);
  if (iso && prevIso && new Date(iso) < new Date(prevIso) - 3600e3) {
    const d = new Date(iso);
    d.setDate(d.getDate() + 1);
    iso = d.toISOString();
  }
  return iso;
}
/** Durée en minutes entre deux horodatages ISO (jamais négative). */
function mins(a, b) {
  return a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : "";
}
/** Libellé lisible d'une journée : « Aujourd'hui », « Hier » ou « lun. 10 nov. ». */
function dayLabel(d) {
  const t = today();
  if (d === t) return "Aujourd'hui";
  const y = localDay(new Date(Date.now() - 864e5));
  if (d === y) return "Hier";
  return new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short" });
}
/** Journée décalée de `n` jours (négatif pour remonter le temps). */
function shiftDay(d, n) {
  const x = new Date(d + "T12:00:00");
  x.setDate(x.getDate() + n);
  return localDay(x);
}
/**
 * Construit les <option> d'un <select>.
 * @param {string[]} arr    valeurs
 * @param {string}   sel    valeur présélectionnée
 * @param {string[]} [labels] libellés affichés (par défaut : la valeur)
 */
function opts(arr, sel, labels) {
  return arr
    .map((o, i) => `<option value="${esc(o)}" ${o === sel ? "selected" : ""}>${esc(labels ? labels[i] : o)}</option>`)
    .join("");
}
/** Nom court d'une opération : supprime le détail entre parenthèses. */
function opShort(op) {
  return (op || "").replace(/\s*\(.*\)\s*$/, "");
}
/** Affiche un message éphémère en bas de l'écran (3,8 s si erreur, sinon 2 s). */
function toast(m, isErr) {
  const t = $("toast");
  t.textContent = m;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), isErr ? 3800 : 2000);
}
/**
 * Vérifie un numéro de conteneur ISO 6346 (4 lettres + 7 chiffres + clé).
 * @returns {boolean|null} null si vide, false si le format ou la clé est faux.
 */
function iso6346valid(cn) {
  if (!cn) return null;
  const s = cn.toUpperCase().replace(/\s/g, "");
  if (!/^[A-Z]{4}[0-9]{7}$/.test(s)) return false;
  const val = {
    A: 10,
    B: 12,
    C: 13,
    D: 14,
    E: 15,
    F: 16,
    G: 17,
    H: 18,
    I: 19,
    J: 20,
    K: 21,
    L: 23,
    M: 24,
    N: 25,
    O: 26,
    P: 27,
    Q: 28,
    R: 29,
    S: 30,
    T: 31,
    U: 32,
    V: 34,
    W: 35,
    X: 36,
    Y: 37,
    Z: 38
  };
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i];
    sum += (/[0-9]/.test(c) ? +c : val[c]) * Math.pow(2, i);
  }
  let cd = sum % 11;
  if (cd === 10) cd = 0;
  return cd === +s[10];
}
/**
 * Devine le site (PSK / BU / KI) à partir d'un libellé libre, ou null.
 * Sert à rattacher un pointage ou un convoi au bon périmètre.
 */
function siteOf(t) {
  t = t || "";
  if (/PSK|Kagbélen/i.test(t)) return "PSK";
  if (/Burkina/i.test(t)) return "BU";
  if (/Kidal/i.test(t)) return "KI";
  return null;
}

/* =====================================================================
   3. STOCKAGE LOCAL ET ÉTAT APPLICATIF
   Tout est préfixé « tct4_ » dans localStorage, pour ne pas écraser
   d'éventuelles autres applications servies sur le même domaine.
   ===================================================================== */

/** Accès typé à localStorage (les erreurs — quota, mode privé — sont neutralisées). */
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem("tct4_" + k);
      return v ? JSON.parse(v) : d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("tct4_" + k, JSON.stringify(v));
      return true;
    } catch (e) {
      toast("⚠ Mémoire du téléphone pleine : enregistrement local impossible", true);
      return false;
    }
  },
  del(k) {
    try {
      localStorage.removeItem("tct4_" + k);
    } catch (e) {}
  }
};
// Nettoyage des données de l'ancienne version (remise à zéro demandée)
try {
  Object.keys(localStorage)
    .filter((k) => k.indexOf("tct3_") === 0)
    .forEach((k) => localStorage.removeItem(k));
} catch (e) {}

/**
 * État global de l'application, chargé du localStorage au démarrage.
 *  - session  : { token, role, entity, site, operateur } ou null
 *  - data     : { [type]: { [id]: objet } } pour les six TYPES métier
 *  - outbox   : { [id]: { type, v, deleted?, prestataire? } } en attente d'envoi
 *  - lastSeq  : dernier numéro de séquence lu sur le serveur
 *  - seen     : { [id]: seq } pour ignorer les lignes déjà appliquées
 *  - settings : paramètres partagés (objectif TEU, contacts)
 *  - day, tab : journée affichée et onglet courant (état d'interface)
 */
const S = {
  session: LS.get("session", null),
  data: {},
  outbox: LS.get("outbox", {}),
  lastSeq: +LS.get("lastSeq", 0) || 0,
  seen: LS.get("seen", {}),
  settings: LS.get("settings", { objTeu: 250, contacts: { prestataires: {}, sites: {}, ct: { equipe: [] } } }),
  day: today(),
  tab: null,
  ui: LS.get("ui", {})
};
TYPES.forEach((t) => (S.data[t] = LS.get("d_" + t, {})));
try {
  applyRef(JSON.parse(localStorage.getItem("tct4_ref") || "null"));
} catch (e) {}
/**
 * Publie les référentiels courants : stockage local, file d'envoi, synchro.
 * Appelée après chaque modification dans l'écran Réglages.
 */
function saveRef() {
  const r = currentRef();
  r._v = Date.now();
  LS.set("ref", r);
  S.outbox.__referentiels__ = { type: "referentiels", v: r._v };
  persistMeta();
  scheduleSync();
}
/** Persiste en local les enregistrements d'un type métier. */
function persistType(t) {
  LS.set("d_" + t, S.data[t]);
}
/** Persiste en local la file d'envoi et la position de lecture du journal. */
function persistMeta() {
  LS.set("outbox", S.outbox);
  LS.set("lastSeq", S.lastSeq);
  LS.set("seen", S.seen);
}
/** Tous les enregistrements d'un type, sous forme de tableau. */
function all(t) {
  return Object.values(S.data[t] || {});
}
/** Un enregistrement par type et identifiant, ou undefined. */
function get(t, id) {
  return (S.data[t] || {})[id];
}
// Toute modification passe par save() : enregistrement local + mise en file d'envoi
/**
 * Point d'entrée UNIQUE pour créer ou modifier un enregistrement.
 * 1. estampille `_v` (horodatage utilisé pour arbitrer les conflits) ;
 * 2. écrit dans S.data et dans la file d'envoi ;
 * 3. persiste, rafraîchit l'écran (sauf `silent`) et planifie la synchro.
 * @param {string} t       type métier (programmes, flotte, …)
 * @param {object} obj     enregistrement complet, `id` inclus
 * @param {boolean} [silent] true pour ne pas redessiner l'écran
 */
function save(t, obj, silent) {
  obj._v = Date.now();
  S.data[t][obj.id] = obj;
  S.outbox[obj.id] = { type: t, v: obj._v };
  persistType(t);
  persistMeta();
  if (!silent) afterChange();
  scheduleSync();
}
/**
 * Supprime localement un enregistrement (tombstone dans la file d'envoi,
 * pour que la suppression soit propagée aux autres appareils).
 */
function remove(t, id) {
  const o = S.data[t][id];
  if (!o) return;
  delete S.data[t][id];
  S.outbox[id] = { type: t, v: Date.now(), deleted: true, prestataire: o.prestataire || null };
  persistType(t);
  persistMeta();
  afterChange();
  scheduleSync();
}
/** Enregistre les paramètres partagés (objectif TEU, contacts) et planifie l'envoi. */
function saveSettings() {
  S.settings._v = Date.now();
  LS.set("settings", S.settings);
  S.outbox.__settings__ = { type: "settings", v: S.settings._v };
  persistMeta();
  scheduleSync();
}
/** Rafraîchit l'écran après une modification, en préservant le focus de saisie. */
function afterChange() {
  renderKeep();
}

/* =====================================================================
   4. SESSION ET PÉRIMÈTRE
   Raccourcis de lecture de la session courante et calcul de ce que le rôle
   connecté a le droit de voir ou de modifier.
   ===================================================================== */
/** Rôle de la session courante (ct, agent, hse, site, presta, pointeur) ou null. */
function role() {
  return S.session ? S.session.role : null;
}
/** Entité de la session : société pour un prestataire, code site pour un chef de site. */
function ent() {
  return S.session ? S.session.entity : null;
}
/** Site déclaré dans la session (facultatif, utilisé pour les agents CT/PSK). */
function psite() {
  return S.session ? S.session.site : null;
}
/** Nom ou matricule de la personne connectée. */
function oper() {
  return S.session ? S.session.operateur : "";
}
/** Site de l'agent terrain : PSK si son entité vaut PSK, sinon CT. */
function agentSite() {
  return ent() === "PSK" ? "PSK" : "CT";
}
/**
 * Périmètre de validation des jalons pour la session courante :
 * « presta », « CT » ou « PSK » ; null pour les rôles qui ne pointent pas.
 */
function myPerimeter() {
  const r = role();
  if (r === "presta" || r === "pointeur") return "presta";
  if (r === "agent") return agentSite();
  return null;
}
/** Jalons que la session courante peut valider. */
function ownedJalons() {
  const p = myPerimeter();
  return p ? JALONS.filter((j) => JALON_OWNER[j] === p) : [];
}
/** Libellé complet de l'utilisateur connecté, affiché dans l'en-tête. */
function whoLabel() {
  const r = role();
  if (!r) return "";
  let s = ROLES[r].label;
  if (r === "agent") s = "Agent " + agentSite();
  if (r === "site") s = "Chef de site " + (SITE_KEYS[ent()] || ent());
  if (r === "presta" || r === "pointeur") s = (r === "presta" ? "Prestataire " : "Pointage ") + ent();
  return s + (psite() ? " · " + psite() : "") + " · " + oper();
}

/* =====================================================================
   5. RÈGLES MÉTIER PARTAGÉES
   Programme, facturation d'une rotation, progression des jalons, flotte.
   Ces fonctions sont pures : elles lisent un objet et renvoient une valeur.
   ===================================================================== */
/** Lignes d'un programme (tableau, jamais null). */
function progLignes(p) {
  return Array.isArray(p.lignes) ? p.lignes : [];
}
/** Nombre total de camions prévus dans un programme. */
function progCam(p) {
  return progLignes(p).reduce((s, l) => s + (+l.camions || 0), 0);
}
/** Volume total prévu dans un programme (en TEU). */
function progVol(p) {
  return progLignes(p).reduce((s, l) => s + (+l.volume || 0), 0);
}
/** Volume réellement réalisé (saisi par le prestataire). */
function progReal(p) {
  return progLignes(p).reduce((s, l) => s + (+l.realise || 0), 0);
}
/** Nombre de TEU d'un conteneur : 2 pour un 40' ou 2x20', sinon 1. */
function teuT(taille) {
  return taille === "40'" || taille === "2x20'" ? 2 : 1;
}
/** true si l'opération sort un conteneur plein du terminal. */
function opSortiePlein(op) {
  return OPS_PLEIN_SORTIE.indexOf(op) >= 0;
}
/** true si la sortie du terminal vaut objectif atteint pour ce voyage. */
function vyCompteObj(v) {
  return opSortiePlein(v.operation) && v.jalons && !!v.jalons[JALON_SORTIE];
}
/** true si le conteneur est revenu à CT (arrivée ou déchargement). */
function rotOK(v) {
  const j = v.jalons || {};
  return !!(j["Arrivée à CT"] || j["Déchargement du vide à CT"]);
}
/**
 * Détermine si un voyage est facturable et sous quel type de prestation.
 * Le type dépend de l'opération commandée et des jalons réellement validés
 * (livraison du plein à PSK et/ou retour du vide à CT).
 * @returns {{facturable: boolean, type: string}} type « — » si non facturable.
 */
function vyFactu(v) {
  const j = v.jalons || {};
  const op = v.operation || "";
  const pleinLivre = !!(j["Déchargement PSK"] || j[JALON_KAG]);
  const retourVide = !!(j["Arrivée à CT"] || j["Déchargement du vide à CT"]);
  let type = null;
  if (/Boucle Complète/i.test(op)) {
    if (pleinLivre && retourVide) type = "Boucle Complète";
    else if (pleinLivre || retourVide) type = "Boucle Simple";
  } else if (/Boucle Simple/i.test(op)) {
    if (pleinLivre || retourVide) type = "Boucle Simple";
  } else if (/Intramuros BU/i.test(op)) {
    if (retourVide) type = "Intramuros BU";
  } else if (/KIDAL/i.test(op)) {
    if (retourVide) type = "Intramuros KIDAL";
  } else if (/pleins Burkina/i.test(op)) {
    if (retourVide) type = "Transfert plein Burkina";
  } else if (/Roro/i.test(op)) {
    if (pleinLivre) type = "Roro";
  } else if (/PSK\s*→\s*PSK/i.test(op)) {
    if (j["Déchargement PSK"]) type = "Intramuros PSK";
  }
  return { facturable: !!type, type: type || "—" };
}
/** Prochain jalon non validé d'un voyage (ou null s'il est terminé). */
function nextJalon(v, list) {
  list = list || JALONS;
  return list.find((j) => !(v.jalons || {})[j]) || null;
}
/** Nombre de jalons validés sur un voyage. */
function vyDone(v) {
  return JALONS.filter((j) => (v.jalons || {})[j]).length;
}
/**
 * Statut d'un voyage : « nonsorti » (sortie manquée), « fini », « attente »
 * (aucun jalon) ou « cours » (rotation en cours).
 */
function vyStatus(v) {
  if (v.sorti && v.sorti !== "Sorti") return "nonsorti";
  if (rotOK(v) || route(v).every((j) => (v.jalons || {})[j])) return "fini";
  if (vyDone(v) === 0) return "attente";
  return "cours";
}
/** Déclaration de flotte la plus récente d'un prestataire pour une journée. */
function flotteDuJour(pr, d) {
  return all("flotte")
    .filter((f) => f.date === d && f.prestataire === pr)
    .sort((a, b) => (a.declaredAt || "").localeCompare(b.declaredAt || ""))
    .pop();
}
/** true si la déclaration a été faite après 8 h (donc en retard). */
function flotteLate(f) {
  return !!(f && f.declaredAt && new Date(f.declaredAt).getHours() >= 8);
}
/** Retraits de camions en cours (sans heure de fin) pour un prestataire. */
function retraitsActifs(pr) {
  return all("retraits").filter((x) => x.prestataire === pr && !x.fin);
}

/* =====================================================================
   6. APPELS API VERS DJANGO
   Un seul point d'entrée POST /api/rpc/<fonction>. Le serveur vérifie la
   session, les droits et les règles métier ; il renvoie du JSON.
   ===================================================================== */

/**
 * Appelle une fonction RPC du serveur.
 * @param {string} fn   nom serveur : tct_connect, tct_pull, tct_push, tct_set_code…
 * @param {object} args arguments nommés attendus par la fonction
 * @returns {Promise<any>} corps JSON décodé (null si réponse vide)
 * @throws {Error} message serveur (`message`) enrichi de `status`
 */
async function rpc(fn, args) {
  // Django valide la session et les droits avant d'exécuter chaque opération.
  const r = await fetch("/api/rpc/" + encodeURIComponent(fn), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  if (!r.ok) {
    let m = "HTTP " + r.status;
    try {
      const j = await r.json();
      m = j.message || m;
    } catch (e) {}
    const er = new Error(m);
    er.status = r.status;
    throw er;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
// Traduction des codes d'erreur renvoyés par Django en messages utilisateur.
const ERRS = {
  code_incorrect: "Code incorrect",
  nom_requis: "Indique ton nom ou matricule",
  session_expiree: "Session expirée : reconnecte-toi",
  non_autorise: "Action non autorisée pour ton accès",
  code_format: "Le code doit compter 4 à 8 chiffres",
  role_inconnu: "Accès inconnu",
  trop_de_tentatives: "Trop d'essais de code : réessaie dans quelques minutes",
  code_deja_utilise: "Ce code est déjà attribué à un autre accès : choisis-en un autre"
};
/**
 * Message lisible pour une erreur quelconque : code métier connu, panne réseau
 * (TypeError de fetch), base non installée (404) ou message brut.
 */
function errMsg(e) {
  if (!e) return "Erreur";
  if (ERRS[e.message]) return ERRS[e.message];
  if (e instanceof TypeError) return "Pas de réseau";
  if (e.status === 404) return "Base non installée (fonctions introuvables)";
  return e.message || "Erreur";
}

/* =====================================================================
   7. SYNCHRONISATION HORS LIGNE
   Principe : le navigateur est la source immédiate (écriture locale), le
   serveur est la source partagée (push puis pull). `SYNC.busy` empêche deux
   cycles concurrents ; `SYNC.timer` regroupe les déclenchements rapprochés.
   ===================================================================== */

/** État du dernier cycle de synchronisation (pour la pastille d'en-tête). */
const SYNC = { state: "idle", msg: "", at: 0, busy: false, timer: null };
/** Nombre de modifications locales encore à envoyer. */
function pendingCount() {
  return Object.keys(S.outbox).length;
}
/** Met à jour l'état de synchronisation et rafraîchit la pastille. */
function setSync(state, msg) {
  SYNC.state = state;
  SYNC.msg = msg || "";
  if (state === "ok") SYNC.at = Date.now();
  paintSync();
}
/**
 * Dessine la pastille d'état : « Connexion… », « N à envoyer », « À jour », ou
 * l'erreur courante (hors ligne / erreur serveur).
 */
function paintSync() {
  const el = $("syncpill");
  if (!el) return;
  const n = pendingCount();
  let cls = "",
    txt = "";
  if (SYNC.state === "err") {
    cls = "err";
    txt = navigator.onLine ? "Erreur" : "Hors ligne";
  } else if (n) {
    cls = "wait";
    txt = n + " à envoyer";
  } else if (SYNC.state === "ok") {
    cls = "ok";
    txt = "À jour";
  } else {
    txt = "Connexion…";
  }
  if (n && SYNC.state === "err") txt = (navigator.onLine ? "Erreur" : "Hors ligne") + " · " + n;
  el.className = "syncpill " + cls;
  el.innerHTML = `<span class="dot"></span>${esc(txt)}`;
}
/** Planifie un cycle de synchronisation (400 ms par défaut, pour regrouper). */
function scheduleSync(ms) {
  clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(syncNow, ms == null ? 400 : ms);
}
/**
 * Un cycle complet : envoi des photos, envoi des modifications, lecture du
 * journal. Une session expirée déconnecte immédiatement l'utilisateur.
 */
async function syncNow() {
  if (!S.session || SYNC.busy) return;
  SYNC.busy = true;
  try {
    await uploadPhotos();
    await push();
    await pull();
    setSync("ok");
  } catch (e) {
    if (e.message === "session_expiree") {
      SYNC.busy = false;
      forceLogout("Session expirée : reconnecte-toi");
      return;
    }
    setSync("err", errMsg(e));
  } finally {
    SYNC.busy = false;
    paintSync();
  }
}
/**
 * Envoie la file d'attente par lots de 40 (limite de taille des requêtes).
 * Les entrées modifiées pendant l'envoi (même id, `v` différent) restent
 * dans la file ; les identifiants refusés sont signalés à l'utilisateur.
 */
async function push() {
  const ids = Object.keys(S.outbox);
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const rows = [];
    const sent = {};
    part.forEach((id) => {
      const o = S.outbox[id];
      if (!o) return;
      sent[id] = o.v;
      if (o.type === "settings") rows.push({ id, type: "settings", data: S.settings, deleted: false });
      else if (o.type === "referentiels") rows.push({ id, type: "referentiels", data: currentRef(), deleted: false });
      else if (o.deleted)
        rows.push({ id, type: o.type, data: { id, prestataire: o.prestataire || null }, deleted: true });
      else {
        const obj = get(o.type, id);
        if (obj) rows.push({ id, type: o.type, data: obj, deleted: false });
        else delete S.outbox[id];
      }
    });
    if (!rows.length) continue;
    const res = await rpc("tct_push", { p_token: S.session.token, p_rows: rows });
    (res.ok || []).concat(res.rejected || []).forEach((id) => {
      if (S.outbox[id] && S.outbox[id].v === sent[id]) delete S.outbox[id];
    });
    if ((res.rejected || []).length)
      toast(res.rejected.length + " modification(s) refusée(s) : hors de ton périmètre", true);
    persistMeta();
  }
}
/**
 * Relit le journal serveur par pages de 300 jusqu'à être à jour.
 * Un recouvrement de 30 séquences évite de manquer une ligne en cas de
 * concurrence entre appareils. Les modifications locales en attente ne sont
 * jamais écrasées : elles feront foi lors du prochain push.
 */
async function pull() {
  let changed = false;
  for (let g = 0; g < 200; g++) {
    const since = Math.max(0, S.lastSeq - 30); // léger recouvrement : aucune ligne manquée
    const rows = await rpc("tct_pull", { p_token: S.session.token, p_since: since, p_limit: 300 });
    let fresh = 0;
    (rows || []).forEach((r) => {
      if (r.seq > S.lastSeq) S.lastSeq = r.seq;
      if (S.seen[r.id] === r.seq) return;
      S.seen[r.id] = r.seq;
      fresh++;
      if (S.outbox[r.id]) return; // modification locale en attente : elle sera envoyée et fera foi
      if (r.type === "referentiels") {
        if (!r.deleted && applyRef(r.data)) {
          LS.set("ref", r.data);
          changed = true;
        }
        return;
      }
      if (r.type === "settings") {
        if (!r.deleted) {
          S.settings = r.data || S.settings;
          LS.set("settings", S.settings);
          changed = true;
        }
        return;
      }
      if (TYPES.indexOf(r.type) < 0) return;
      if (r.deleted) {
        if (S.data[r.type][r.id]) {
          delete S.data[r.type][r.id];
          changed = true;
        }
      } else {
        S.data[r.type][r.id] = r.data;
        changed = true;
      }
      S._dirty = S._dirty || {};
      S._dirty[r.type] = 1;
    });
    if (S._dirty) {
      Object.keys(S._dirty).forEach(persistType);
      S._dirty = null;
    }
    persistMeta();
    if (!rows || rows.length < 300 || !fresh) break;
  }
  if (changed) renderIfIdle();
}
/** Redessine l'écran seulement si l'utilisateur ne saisit rien et si aucune feuille n'est ouverte. */
function renderIfIdle() {
  const a = document.activeElement;
  if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
  if (SHEET.open) return;
  render();
}
// Déclencheurs de synchronisation : retour du réseau, retour sur l'onglet,
// et battement régulier de 5 s tant que la page est visible.
window.addEventListener("online", () => scheduleSync(100));
window.addEventListener("offline", () => {
  setSync("err", "Hors ligne");
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleSync(100);
});
setInterval(() => {
  if (S.session && !document.hidden) syncNow();
}, 5000);

/* =====================================================================
   8. PHOTOS
   Une photo est d'abord réduite et gardée dans IndexedDB sous la référence
   « idb:<clé> », puis envoyée à /api/photos/ et remplacée par l'URL du
   fichier média Django. Les images affichées reçoivent le jeton de session.
   ===================================================================== */

/** Mini-couche IndexedDB (store « photos ») : open / put / get / del. */
const IDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      if (this.db) return res(this.db);
      const q = indexedDB.open("tct4", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("photos");
      q.onsuccess = () => {
        this.db = q.result;
        res(this.db);
      };
      q.onerror = () => rej(q.error);
    });
  },
  async put(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("photos", "readwrite");
      tx.objectStore("photos").put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const q = db.transaction("photos").objectStore("photos").get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  },
  async del(k) {
    const db = await this.open();
    return new Promise((res) => {
      const tx = db.transaction("photos", "readwrite");
      tx.objectStore("photos").delete(k);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
};
/**
 * Réduit une image (max 1280 px de côté) et la convertit en JPEG base64
 * qualité 0,6 : indispensable pour tenir dans la mémoire d'un téléphone.
 * @param {File} file fichier choisi par l'appareil photo
 * @returns {Promise<string>} data URL JPEG
 */
function compressPhoto(file) {
  return new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onerror = rej;
    rd.onload = () => {
      const img = new Image();
      img.onerror = rej;
      img.onload = () => {
        const max = 1280;
        let w = img.width,
          h = img.height;
        if (w > max || h > max) {
          if (w >= h) {
            h = Math.round((h * max) / w);
            w = max;
          } else {
            w = Math.round((w * max) / h);
            h = max;
          }
        }
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        res(cv.toDataURL("image/jpeg", 0.6));
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}
/** Stocke une photo compressée dans IndexedDB et renvoie sa référence « idb:… ». */
async function storeLocalPhoto(dataUrl) {
  const k = "p_" + uid();
  await IDB.put(k, dataUrl);
  return "idb:" + k;
}
/**
 * Ajoute le jeton de session aux URLs locales de photos.
 * Les balises <img> ne peuvent pas porter d'en-tête : le serveur accepte
 * donc aussi ?token=. Les URLs absolues (anciennes photos Supabase) sont
 * renvoyées telles quelles.
 */
function withPhotoToken(url) {
  if (!url || !S.session || url.indexOf("/api/photos/") !== 0) return url;
  return url + (url.indexOf("?") < 0 ? "?" : "&") + "token=" + encodeURIComponent(S.session.token);
}
/**
 * Résout une référence de photo en URL affichable : lit IndexedDB pour les
 * photos encore en attente, ajoute le jeton pour les photos déjà envoyées.
 */
async function photoSrc(ref) {
  if (!ref) return "";
  if (ref.indexOf("idb:") === 0) {
    return (await IDB.get(ref.slice(4))) || "";
  }
  return withPhotoToken(ref);
}
/**
 * Envoie les photos encore locales et remplace leur référence par l'URL
 * renvoyée par le serveur. Une erreur HTTP (413 trop lourde, 429 débit
 * dépassé, 401 session fermée) interrompt le cycle : la photo reste en
 * IndexedDB et sera renvoyée au prochain passage.
 */
async function uploadPhotos() {
  for (const p of all("pointages")) {
    const ph = p.photos || {};
    let upd = false;
    for (const k of Object.keys(ph)) {
      const ref = ph[k];
      if (typeof ref !== "string" || ref.indexOf("idb:") !== 0) continue;
      const data = await IDB.get(ref.slice(4));
      if (!data) continue; // photo prise sur un autre appareil : l'envoi se fait depuis celui-ci
      const blob = await (await fetch(data)).blob();
      const path = p.id + "_" + k + "_" + uid() + ".jpg";
      const r = await fetch("/api/photos/" + encodeURIComponent(path), {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", "X-Tct-Token": S.session.token },
        body: blob
      });
      if (!r.ok) throw new Error("Envoi photo impossible (HTTP " + r.status + ")");
      const saved = await r.json();
      ph[k] = saved.url;
      upd = true;
      await IDB.del(ref.slice(4));
    }
    if (upd) {
      p.photos = ph;
      save("pointages", p, true);
    }
  }
}
