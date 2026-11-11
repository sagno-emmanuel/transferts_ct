/* =====================================================================
   Transferts CT — SHELL (coquille de l'application)
   =====================================================================
   Chargé après core.js. Contient :
     1. La feuille modale (« sheet ») utilisée par tous les écrans.
     2. La navigation (menu latéral, barre basse, badges).
     3. Le rendu principal : render() choisit la vue selon S.tab.
     4. L'écran de connexion (nom + code, puis choix du site / du mode).

   Point clé : aucun écran ne manipule le DOM à la main. Chaque vue renvoie
   une chaîne HTML, render() l'injecte, et les interactions passent par des
   attributs onclick qui appellent les fonctions globales.
   ===================================================================== */

/* =====================================================================
   1. FEUILLE MODALE
   Panneau glissant depuis le bas, avec fond cliquable.
   ===================================================================== */

/** État de la feuille courante : ouverte ?, callback de fermeture, rafraîchissement. */
const SHEET = { open: false, onClose: null };

/**
 * Ouvre une feuille modale.
 * @param {string}   html    contenu HTML
 * @param {Function} [onClose] appelé à la fermeture
 * @param {Function} [refresh] rappelé avant chaque redessin (saisie en cours)
 */
function openSheet(html, onClose, refresh) {
  SHEET.open = true;
  SHEET.onClose = onClose || null;
  SHEET.refresh = refresh || null;
  $("sheet").innerHTML =
    `<div class="sheet-bg" onclick="if(event.target===this)closeSheet()"><div class="sheet"><div class="grab"></div>${html}</div></div>`;
}
/** Remplace le contenu de la feuille ouverte en conservant sa position de défilement. */
function sheetHTML(html) {
  const s = document.querySelector("#sheet .sheet");
  if (s) {
    const y = s.scrollTop;
    s.innerHTML = `<div class="grab"></div>` + html;
    s.scrollTop = y;
  }
}
/** Ferme la feuille, exécute son callback de fermeture puis redessine l'écran. */
function closeSheet() {
  SHEET.open = false;
  SHEET.refresh = null;
  $("sheet").innerHTML = "";
  const f = SHEET.onClose;
  SHEET.onClose = null;
  if (f) f();
  render();
}

/* =====================================================================
   2. NAVIGATION
   Chaque rôle voit un menu différent, défini par navFor().
   Format d'une entrée : [identifiant d'onglet, icône, libellé].
   ===================================================================== */

/**
 * Menu autorisé pour un rôle.
 * @param {string} r rôle (ct, agent, hse, site, presta, pointeur)
 * @returns {Array<[string, string, string]>} entrées [onglet, icône, libellé]
 */
function navFor(r) {
  if (r === "ct")
    return [
      ["bord", "📊", "Tableau de bord"],
      ["ordres", "📋", "Ordres"],
      ["rotations", "⏱️", "Rotations"],
      ["pointages", "📦", "Pointages"],
      ["convois", "🚚", "Convois"],
      ["incidents", "🚨", "Incidents"],
      ["reglages", "⚙️", "Réglages"]
    ];
  if (r === "agent")
    return agentSite() === "PSK"
      ? [
          ["rotations", "⏱️", "Rotations"],
          ["pointage", "📦", "Pointer"],
          ["programme", "📋", "Programme"],
          ["incidents", "🚨", "Incidents"]
        ]
      : [
          ["rotations", "⏱️", "Rotations"],
          ["pointage", "📦", "Pointer"],
          ["convois", "🚚", "Convois"],
          ["programme", "📋", "Programme"],
          ["incidents", "🚨", "Incidents"]
        ];
  if (r === "hse")
    return [
      ["convois", "🚚", "Convois"],
      ["incidents", "🚨", "Incidents"]
    ];
  if (r === "site")
    return [
      ["reception", "📥", "Réception"],
      ["programme", "📋", "Flux prévus"]
    ];
  if (r === "presta")
    return [
      ["flotte", "🚚", "Ma flotte"],
      ["programme", "📋", "Ordres"],
      ["rotations", "⏱️", "Rotations"],
      ["export", "⬇️", "Export"]
    ];
  if (r === "pointeur") return [["pointage", "📦", "Pointer"]];
  return [];
}
/**
 * Compteur affiché sur un onglet (0 = pas de badge) :
 * ordres non confirmés, réceptions à contresigner, flotte du jour non déclarée.
 */
function navBadge(id) {
  const r = role(),
    d = S.day;
  if (id === "programme" && r === "presta")
    return all("programmes").filter((p) => p.date === d && p.prestataire === ent() && !p.confirm && !p.closed).length;
  if (id === "reception") return all("pointages").filter((p) => p.site === SITE_KEYS[ent()] && !p.contreSigne).length;
  if (id === "flotte" && r === "presta") return flotteDuJour(ent(), today()) ? 0 : 1;
  return 0;
}
/** Change d'onglet, mémorise le choix et redessine. */
function go(t) {
  S.tab = t;
  S.ui.tab = t;
  LS.set("ui", S.ui);
  window.scrollTo(0, 0);
  render();
}

/* =====================================================================
   3. RENDU PRINCIPAL
   render() reconstruit toute la page à chaque changement. Pour ne pas
   perdre la saisie en cours, renderKeep() mémorise le champ actif et sa
   position de curseur, puis les restaure après le rendu.
   ===================================================================== */

let _renderPending = false;

/** Identifiant stable du champ actif : « #id » ou son attribut de liaison. */
function fieldKey(el) {
  if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return null;
  return el.id
    ? "#" + el.id
    : ["onchange", "oninput", "placeholder"].map((a) => el.getAttribute(a)).find(Boolean) || null;
}
/** Replace le focus et le curseur sur le champ identifié par `key`. */
function refocus(key, sel) {
  if (!key) return;
  let el = null;
  if (key[0] === "#") el = document.getElementById(key.slice(1));
  else
    el = [...document.querySelectorAll("input,select,textarea")].find((x) =>
      ["onchange", "oninput", "placeholder"].some((a) => x.getAttribute(a) === key)
    );
  if (el) {
    el.focus();
    try {
      if (sel != null && el.setSelectionRange) el.setSelectionRange(sel, sel);
    } catch (e) {}
  }
}
/**
 * Rend une seule fois par image d'animation (requestAnimationFrame) en
 * préservant le focus : utilisé après chaque modification de données.
 */
function renderKeep() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => {
    _renderPending = false;
    const a = document.activeElement;
    const key = fieldKey(a);
    let sel = null;
    try {
      sel = a && a.selectionStart;
    } catch (e) {}
    if (SHEET.open && SHEET.refresh) SHEET.refresh();
    render();
    refocus(key, sel);
  });
}
/**
 * Rendu complet : écran de connexion si aucune session, sinon en-tête +
 * navigation (latérale sur ordinateur, basse sur téléphone) + vue courante.
 */
function render() {
  const root = $("root");
  if (!S.session) {
    root.innerHTML = loginView();
    return;
  }
  const nav = navFor(role());
  if (!S.tab || !nav.find((n) => n[0] === S.tab))
    S.tab = S.ui.tab && nav.find((n) => n[0] === S.ui.tab) ? S.ui.tab : nav[0][0];
  const main = viewFor(S.tab);
  const mob = nav.length > 5 ? nav.slice(0, 4).concat([["__plus", "☰", "Plus"]]) : nav;
  root.innerHTML = `<div class="top"><div class="grow"><div class="brand">Transferts CT</div><div class="who">${esc(whoLabel())}</div></div>
    <button id="syncpill" class="syncpill" onclick="syncSheet()"></button><button class="iconbtn" onclick="accountSheet()">☰</button></div>
    <div class="layout"><nav class="side">${nav
      .map(([id, ic, lb]) => {
        const b = navBadge(id);
        return `<button class="${id === S.tab ? "on" : ""}" onclick="go('${id}')"><span class="ic">${ic}</span>${lb}${b ? `<span class="badge">${b}</span>` : ""}</button>`;
      })
      .join("")}</nav>
    <main>${main}</main></div>
    <nav class="bottomnav">${mob
      .map(([id, ic, lb]) => {
        const b = id === "__plus" ? 0 : navBadge(id);
        const on = id === S.tab || (id === "__plus" && !mob.find((m) => m[0] === S.tab));
        return `<button class="${on ? "on" : ""}" onclick="${id === "__plus" ? "moreSheet()" : `go('${id}')`}"><span class="ic">${ic}</span>${lb}${b ? `<span class="badge">${b}</span>` : ""}</button>`;
      })
      .join("")}</nav>`;
  document.body.classList.toggle("nonav", nav.length < 2);
  paintSync();
  if (typeof afterRender === "function") afterRender();
}
/**
 * Construit le HTML de l'onglet demandé. Toute erreur d'une vue est capturée
 * et affichée en bandeau : un écran cassé ne bloque pas l'application.
 */
function viewFor(t) {
  const V = {
    bord: viewBord,
    ordres: viewOrdres,
    rotations: viewRotations,
    pointages: viewPointagesCT,
    convois: viewConvois,
    incidents: viewIncidents,
    reglages: viewReglages,
    pointage: viewPointage,
    programme: viewProgramme,
    reception: viewReception,
    flotte: viewFlotte,
    export: viewExport
  };
  try {
    return (V[t] || (() => ""))();
  } catch (e) {
    console.error(e);
    return `<div class="banner err">Erreur d'affichage : ${esc(e.message)}</div>`;
  }
}
/** Feuille « Plus » : onglets au-delà des quatre premiers (téléphone). */
function moreSheet() {
  const nav = navFor(role());
  openSheet(
    `<h3>Menu</h3>${nav
      .slice(4)
      .map(
        ([id, ic, lb]) =>
          `<button class="btn sec block" style="margin-top:8px;justify-content:flex-start" onclick="closeSheet();go('${id}')">${ic} ${lb}</button>`
      )
      .join("")}`
  );
}
/** Barre de navigation par journée (veille / date / lendemain / retour à aujourd'hui). */
function dayBar() {
  return `<div class="daybar"><button onclick="setDay(shiftDay(S.day,-1))" aria-label="Jour précédent">‹</button>
  <div class="dlabel">${esc(dayLabel(S.day))} <span class="small muted">${esc(S.day.split("-").reverse().join("/"))}</span><input type="date" value="${S.day}" onchange="setDay(this.value)"></div>
  ${S.day !== today() ? `<button class="today" onclick="setDay(today())">Aujourd'hui</button>` : ""}<button onclick="setDay(shiftDay(S.day,1))" aria-label="Jour suivant">›</button></div>`;
}
/** Change la journée affichée et redessine. */
function setDay(d) {
  if (!d) return;
  S.day = d;
  render();
}
/** Feuille d'état de la synchronisation, avec bouton « Synchroniser maintenant ». */
function syncSheet() {
  const n = pendingCount();
  openSheet(`<h3>Synchronisation</h3>
  <div class="kv"><span class="k">État</span><b>${SYNC.state === "ok" ? "À jour" : SYNC.state === "err" ? "En échec" : "Connexion…"}</b></div>
  ${SYNC.msg ? `<div class="kv"><span class="k">Détail</span><span>${esc(SYNC.msg)}</span></div>` : ""}
  <div class="kv"><span class="k">Modifications à envoyer</span><b>${n}</b></div>
  <div class="kv"><span class="k">Dernière synchro réussie</span><span>${SYNC.at ? hm(new Date(SYNC.at).toISOString()) : "—"}</span></div>
  <p class="small muted">Les saisies sont gardées sur l'appareil et partent automatiquement dès que le réseau revient.</p>
  <button class="btn block" onclick="syncNow().then(()=>{closeSheet();toast(SYNC.state==='ok'?'Synchronisé':'Échec : '+SYNC.msg,SYNC.state!=='ok');})">Synchroniser maintenant</button>`);
}
/** Feuille du compte : identité, version, synchro manuelle, déconnexion. */
function accountSheet() {
  openSheet(`<h3>${esc(whoLabel())}</h3><p class="small muted">Version ${VERSION}</p>
  <button class="btn sec block" onclick="closeSheet();syncNow()">Synchroniser</button>
  <div style="height:8px"></div><button class="btn err block" onclick="logout()">Se déconnecter</button>`);
}
/**
 * Déconnexion demandée par l'utilisateur : prévient si des modifications
 * sont encore en attente, invalide la session côté serveur, vide le local.
 */
async function logout() {
  const n = pendingCount();
  if (n && !confirm(n + " modification(s) ne sont pas encore envoyées et seront perdues. Se déconnecter quand même ?"))
    return;
  try {
    await rpc("tct_logout", { p_token: S.session.token });
  } catch (e) {}
  clearLocal();
  closeSheet();
}
/** Déconnexion subie (session expirée) : efface la session et affiche la raison. */
function forceLogout(msg) {
  S.session = null;
  LS.del("session");
  render();
  toast(msg, true);
}
/**
 * Vide toutes les données locales (session, enregistrements, file d'envoi,
 * paramètres) sans toucher au serveur. Appelée à la connexion et à la
 * déconnexion pour éviter de mélanger deux comptes ou deux sociétés.
 */
function clearLocal() {
  S.session = null;
  LS.del("session");
  TYPES.forEach((t) => {
    S.data[t] = {};
    LS.del("d_" + t);
  });
  S.outbox = {};
  S.lastSeq = 0;
  S.seen = {};
  persistMeta();
  LS.del("settings");
  S.tab = null;
}

/* =====================================================================
   4. CONNEXION
   Un seul écran : nom (ou matricule) + code personnel. C'est le serveur qui
   détermine le rôle associé au code ; l'utilisateur ne choisit que son site
   ou, pour un prestataire, entre gestion de flotte et pointage.
   Étapes (LOGIN.step) : « code » -> « choice » -> session ouverte.
   ===================================================================== */

/** État de l'écran de connexion (le code n'est jamais conservé après succès). */
const LOGIN = { step: "code", pin: "", busy: false, pending: null, mode: null };
/** HTML de l'écran de connexion : pavé numérique ou choix du site / du mode. */
function loginView() {
  const L = LOGIN;
  let h = `<div class="login"><div class="box">`;
  if (L.step === "code") {
    const last = LS.get("lastOper", "");
    h += `<h1>Transferts CT</h1><p>Conakry Terminal · Service Transport</p>
      <label class="f" style="color:#AEC4DA">Nom ou matricule</label><input class="in" id="lg_op" value="${esc(last)}" placeholder="ex. A. Diallo / 1666" autocomplete="off">
      <label class="f" style="color:#AEC4DA">Code d'accès</label>
      <div class="pindots">${Array.from({ length: Math.max(4, L.pin.length) }, (_, i) => `<i class="${L.pin.length > i ? "f" : ""}"></i>`).join("")}</div>
      <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button onclick="pinKey('${n}')">${n}</button>`).join("")}<button onclick="pinKey('C')" style="font-size:15px">Effacer</button><button onclick="pinKey('0')">0</button><button onclick="doLogin()" style="background:#F2B84B;color:#1A2430;font-size:16px">${L.busy ? "…" : "Entrer"}</button></div>
      <p class="small center" style="margin-top:14px">Code personnel communiqué par le service Transport.</p>`;
  } else {
    const P = L.pending;
    const back = `<button class="back" onclick="cancelChoice()">‹ Changer de code</button>`;
    if (P.role === "agent")
      h +=
        back +
        `<h1>Bonjour ${esc(P.operateur)}</h1><p>Sur quel site travailles-tu ?</p><div class="entgrid">${["CT", "PSK"].map((e) => `<div class="rolecard" onclick="finishLogin('agent','${e}','')">${esc(AGENT_SITE_LABEL[e])}</div>`).join("")}</div>`;
    else if (P.role === "site")
      h +=
        back +
        `<h1>Bonjour ${esc(P.operateur)}</h1><p>Quel est ton site ?</p><div class="entgrid">${Object.keys(SITE_KEYS)
          .map((e) => `<div class="rolecard" onclick="finishLogin('site','${e}','')">${esc(SITE_KEYS[e])}</div>`)
          .join("")}</div>`;
    else if (P.role === "presta" && L.mode !== "pointage")
      h +=
        back +
        `<h1>${esc(P.entity)}</h1><p>Que veux-tu faire ?</p>
      <div class="rolecard" onclick="finishLogin('presta','${esc(P.entity)}','')"><div class="ri">🚚</div><div><div class="rt">Flotte, ordres et rotations</div><div class="rd">Déclarer la flotte, confirmer les ordres, suivre les camions.</div></div></div>
      <div class="rolecard" onclick="LOGIN.mode='pointage';render()"><div class="ri">📦</div><div><div class="rt">Pointage des conteneurs</div><div class="rd">Pointer les arrivées et départs sur un site.</div></div></div>`;
    else
      h += `<button class="back" onclick="LOGIN.mode=null;render()">‹ Retour</button><h1>Pointage ${esc(P.entity)}</h1><p>Sur quel site pointes-tu ?</p>
      ${SITES.map((s) => `<div class="rolecard" onclick="finishLogin('pointeur','${esc(P.entity)}','${esc(s)}')"><div class="ri">📍</div><div class="rt">${esc(s)}</div></div>`).join("")}`;
  }
  return h + `</div></div>`;
}
/**
 * Gère le pavé numérique : chiffre, ou « C » pour effacer.
 * Le nom saisi est réinjecté après le rendu car le champ est recréé.
 */
function pinKey(k) {
  const op = $("lg_op");
  const opv = op ? op.value : "";
  if (k === "C") LOGIN.pin = LOGIN.pin.slice(0, -1);
  else if (LOGIN.pin.length < 8) LOGIN.pin += k;
  render();
  const o = $("lg_op");
  if (o) o.value = opv;
}
// Confort sur ordinateur : chiffres, Retour arrière et Entrée pilotent le pavé.
document.addEventListener("keydown", (e) => {
  if (S.session || LOGIN.step !== "code") return;
  if (document.activeElement && document.activeElement.id === "lg_op") {
    if (e.key === "Enter") doLogin();
    return;
  }
  if (/^[0-9]$/.test(e.key)) pinKey(e.key);
  else if (e.key === "Backspace") pinKey("C");
  else if (e.key === "Enter") doLogin();
});
/**
 * Étape 1 : envoie le code (tct_connect). Selon la réponse, ouvre directement
 * la session (CT, HSE) ou passe à l'étape de choix du site / du mode.
 */
async function doLogin() {
  if (LOGIN.busy) return;
  const op = (($("lg_op") || {}).value || "").trim();
  if (!op) {
    toast("Indique ton nom ou matricule", true);
    return;
  }
  if (LOGIN.pin.length < 4) {
    toast("Saisis ton code", true);
    return;
  }
  LOGIN.busy = true;
  render();
  $("lg_op").value = op;
  try {
    const s = await rpc("tct_connect", { p_code: LOGIN.pin, p_operateur: op });
    LS.set("lastOper", op);
    LOGIN.pin = "";
    LOGIN.busy = false;
    if (s.role === "ct" || s.role === "hse") {
      enterSession(s);
      return;
    }
    LOGIN.pending = s;
    LOGIN.mode = null;
    LOGIN.step = "choice";
    render();
  } catch (e) {
    LOGIN.busy = false;
    LOGIN.pin = "";
    render();
    const o = $("lg_op");
    if (o) o.value = op;
    toast(errMsg(e), true);
  }
}
/**
 * Étape 2 : fixe le rôle, l'entité et le site de la session ouverte
 * (tct_session_set), puis entre dans l'application.
 */
async function finishLogin(r, e, site) {
  const P = LOGIN.pending;
  if (!P || LOGIN.busy) return;
  LOGIN.busy = true;
  try {
    const s = await rpc("tct_session_set", { p_token: P.token, p_role: r, p_entity: e, p_site: site });
    enterSession(s);
  } catch (err) {
    LOGIN.busy = false;
    if (err.message === "session_expiree") {
      cancelChoice();
    }
    toast(errMsg(err), true);
  }
}
/** Revient à la saisie du code depuis l'écran de choix. */
function cancelChoice() {
  LOGIN.pending = null;
  LOGIN.mode = null;
  LOGIN.step = "code";
  LOGIN.busy = false;
  render();
}
/** Ouvre la session : nettoie les données de l'appareil, enregistre la session, affiche l'app et lance une synchro. */
function enterSession(s) {
  clearLocal();
  S.session = s;
  LS.set("session", s);
  Object.assign(LOGIN, { step: "code", pin: "", busy: false, pending: null, mode: null });
  S.day = today();
  render();
  toast("Bienvenue " + s.operateur);
  syncNow();
}
