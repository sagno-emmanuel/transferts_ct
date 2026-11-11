/* =====================================================================
   Transferts CT — CONVOIS, TABLEAU DE BORD, RÉGLAGES, EXPORT
   =====================================================================
   Chargé en dernier : ce fichier contient aussi le démarrage de l'appli.

   Sommaire :
     1. Convois      : fiche de sortie, escorte, douane, HSE, TBM.
     2. Tableau de bord : KPI du jour, synthèse par prestataire, alertes.
     3. Réglages     : objectif TEU, codes d'accès, prestataires, contacts,
                       sauvegarde JSON.
     4. Export       : classeur Excel (une feuille par type de donnée).
     5. Démarrage    : render() puis synchro si une session est ouverte.
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. CONVOIS
   Un convoi (type `convois`) suit une sortie groupée de camions :
   fiches GA et chef de parc, escorte, douane, HSE et TBM, puis le trajet.
   ------------------------------------------------------------------- */

/** Écran Convois : les convois de la journée affichée. */
function viewConvois() {
  const r = role();
  const l = all("convois")
    .filter((c) => c.date === S.day)
    .sort((a, b) => (a.cree || "").localeCompare(b.cree || ""));
  const canCreate = r === "agent" || r === "ct";
  return `<h1 class="page">Convois</h1>${dayBar()}
    ${l.length ? `<div class="grid2">${l.map((c, i) => cvCard(c, i)).join("")}</div>` : `<div class="empty">Aucun convoi pour cette journée.</div>`}
    ${canCreate && S.day === today() ? `<button class="fab" onclick="newConvoi()">＋ Nouveau convoi</button>` : ""}`;
}
// Étapes du convoi dans l'ordre : [clé technique, libellé affiché].
const CV_STEPS = [
  ["gaDepot", "Fiche GA déposée"],
  ["gaRecep", "Fiche GA signée"],
  ["cpDepot", "Fiche chef de parc déposée"],
  ["cpRecep", "Fiche chef de parc signée"],
  ["escArr", "Escorte arrivée"],
  ["appelDou", "Douane appelée"],
  ["arrDou", "Douane arrivée"],
  ["appelHse", "HSE appelé"],
  ["arrHse", "HSE arrivé"],
  ["tbmDebut", "TBM début"],
  ["tbmFin", "TBM fin"],
  ["depart", "Départ du convoi"],
  ["arrKag", "Arrivée à Kagbélen"]
];
// Rôle autorisé à renseigner chaque étape (le CT peut tout modifier).
const CV_OWNER = {
  gaDepot: "agent",
  gaRecep: "agent",
  cpDepot: "agent",
  cpRecep: "agent",
  escArr: "agent",
  appelDou: "agent",
  arrDou: "agent",
  appelHse: "agent",
  arrHse: "hse",
  tbmDebut: "hse",
  tbmFin: "hse",
  depart: "hse",
  arrKag: "hse"
};
/** true si la session courante peut renseigner cette étape du convoi. */
function cvCanEdit(k) {
  const r = role();
  return r === "ct" || CV_OWNER[k] === r;
}
/** Prochaine étape que l'utilisateur courant peut valider (ou undefined). */
function cvNext(c) {
  return CV_STEPS.find(([k]) => !c[k] && cvCanEdit(k));
}
/** Carte d'un convoi : progression, indicateurs fiche/TBM et action rapide. */
function cvCard(c, i) {
  const n = CV_STEPS.filter(([k]) => c[k]).length;
  const nx = cvNext(c);
  return `<div class="item"><div class="between"><span class="t">Convoi ${i + 1}</span><span class="small muted">${c.nbCamions || 0} camion(s)</span></div>
    <div class="steps">${CV_STEPS.map(([k]) => `<i class="${c[k] ? "d" : ""}"></i>`).join("")}</div>
    <div style="margin-top:8px">${c.signe ? `<span class="pill ok">Fiche signée</span>` : `<span class="pill warn">Fiche non signée</span>`} ${c.tbmFait ? `<span class="pill ok">TBM fait</span>` : `<span class="pill warn">TBM à faire</span>`} ${c.depart ? `<span class="pill info">Parti ${hm(c.depart)}</span>` : ""} ${c.arrKag ? `<span class="pill ok">Arrivé ${hm(c.arrKag)} · ${mins(c.depart, c.arrKag)} min</span>` : ""}</div>
    <div class="acts">${nx ? `<button class="btn ok" onclick="cvStamp('${c.id}','${nx[0]}')">▶ ${esc(nx[1])}</button>` : ""}<button class="btn sec" style="flex:0 0 auto" onclick="openConvoi('${c.id}')">Détails</button></div></div>`;
}
/** Crée un convoi vide daté d'aujourd'hui et ouvre sa feuille. */
function newConvoi() {
  const c = {
    id: uid(),
    date: today(),
    cree: nowISO(),
    nbCamions: 0,
    signe: false,
    escNb: 0,
    tbmFait: false,
    operateur: oper()
  };
  CV_STEPS.forEach(([k]) => (c[k] = ""));
  save("convois", c);
  openConvoi(c.id);
}
/**
 * Valide une étape du convoi à l'heure courante et met à jour les
 * indicateurs dérivés : fiche signée (GA + chef de parc) et TBM effectué.
 */
function cvStamp(id, k) {
  const c = get("convois", id);
  c[k] = nowISO();
  if (k === "gaRecep" || k === "cpRecep") {
    if (c.gaRecep && c.cpRecep) c.signe = true;
  }
  if (k === "tbmFin") c.tbmFait = true;
  save("convois", c);
  toast(CV_STEPS.find((s) => s[0] === k)[1] + " · " + hm(c[k]));
}
/** Ouvre le détail d'un convoi, rafraîchi après chaque modification. */
function openConvoi(id) {
  const draw = () => {
    const c = get("convois", id);
    if (!c) {
      closeSheet();
      return;
    }
    sheetHTML(convoiHTML(c));
  };
  openSheet(convoiHTML(get("convois", id)), null, draw);
}
/**
 * Contenu du détail d'un convoi : nombre de camions, fiches, escorte et
 * douane, HSE, TBM, trajet, avec les délais calculés entre étapes.
 */
function convoiHTML(c) {
  const r = role();
  const ag = r === "agent" || r === "ct",
    hse = r === "hse" || r === "ct";
  const row = (k, l) => {
    const ts = c[k];
    const ed = cvCanEdit(k);
    return `<div class="jal ${ts ? "done" : ""}"><div class="num">${ts ? "✓" : "•"}</div><div class="jn">${esc(l)}<small>${CV_OWNER[k] === "hse" ? "HSE" : "Agent CT"}</small></div>
    ${ed ? `<input type="time" value="${ts ? new Date(ts).toTimeString().slice(0, 5) : ""}" onchange="cvSet('${c.id}','${k}',this.value)">${ts ? "" : `<button class="btn accent sm" onclick="cvStamp('${c.id}','${k}')">Top</button>`}` : `<span class="tm">${ts ? hm(ts) : "—"}</span>`}</div>`;
  };
  const delay = (a, b, l) =>
    c[a] && c[b] ? `<div class="small muted" style="margin:2px 0 6px 36px">${l} : ${mins(c[a], c[b])} min</div>` : "";
  const sw = (k, l, ed) =>
    `<div class="jal"><div class="jn">${l}</div><button class="switch ${c[k] ? "on" : ""}" ${ed ? `onclick="cvToggle('${c.id}','${k}')"` : "disabled"}></button></div>`;
  return `<div class="between"><h3>Convoi · ${esc(dayLabel(c.date))}</h3><button class="btn ghost" onclick="closeSheet()">Fermer</button></div>
    <div class="row"><div><label class="f">Camions du convoi</label><input class="in" type="number" inputmode="numeric" value="${c.nbCamions || ""}" ${ag ? `onchange="cvNum('${c.id}','nbCamions',this.value)"` : "disabled"}></div>
      <div><label class="f">Chauffeurs d'escorte</label><input class="in" type="number" inputmode="numeric" value="${c.escNb || ""}" ${ag ? `onchange="cvNum('${c.id}','escNb',this.value)"` : "disabled"}></div></div>
    <h2 class="sec">Fiche de sortie</h2>${row("gaDepot", "Global Access : dépôt")}${row("gaRecep", "Global Access : réception signée")}${delay("gaDepot", "gaRecep", "Délai GA")}
    ${row("cpDepot", "Chef de parc : dépôt")}${row("cpRecep", "Chef de parc : réception signée")}${delay("cpDepot", "cpRecep", "Délai chef de parc")}${sw("signe", "Signature obtenue", ag)}
    <h2 class="sec">Escorte et douane</h2>${row("escArr", "Arrivée de l'escorte")}${row("appelDou", "Douanier appelé")}${row("arrDou", "Douanier arrivé")}${delay("appelDou", "arrDou", "Délai douane")}
    <h2 class="sec">HSE</h2>${row("appelHse", "HSE appelé")}${row("arrHse", "HSE arrivé")}${delay("appelHse", "arrHse", "Délai HSE")}
    ${row("tbmDebut", "TBM : début")}${row("tbmFin", "TBM : fin")}${sw("tbmFait", "TBM réellement effectué", hse)}
    <h2 class="sec">Trajet</h2>${row("depart", "Départ du convoi")}${row("arrKag", "Arrivée à Kagbélen")}${delay("depart", "arrKag", "Temps de route")}
    ${r === "ct" || r === "agent" ? `<button class="btn ghost block" style="margin-top:10px;color:var(--err)" onclick="if(confirm('Supprimer ce convoi ?')){remove('convois','${c.id}');closeSheet();}">Supprimer le convoi</button>` : ""}`;
}
/**
 * Saisie manuelle de l'heure d'une étape (recalée au lendemain si elle
 * précède de plus d'une heure l'étape précédente).
 */
function cvSet(id, k, val) {
  const c = get("convois", id);
  const idx = CV_STEPS.findIndex((s) => s[0] === k);
  const prev = CV_STEPS.slice(0, idx)
    .map((s) => c[s[0]])
    .filter(Boolean)
    .sort()
    .pop();
  c[k] = val ? isoAfter(c.date, val, prev) : "";
  save("convois", c);
}
/** Enregistre un compteur du convoi (camions, chauffeurs d'escorte). */
function cvNum(id, k, val) {
  const c = get("convois", id);
  c[k] = Math.max(0, Math.round(+val || 0));
  save("convois", c);
}
/** Bascule un indicateur booléen du convoi (fiche signée, TBM fait). */
function cvToggle(id, k) {
  const c = get("convois", id);
  c[k] = !c[k];
  save("convois", c);
}

/* =====================================================================
   2. TABLEAU DE BORD (donneur d'ordre)
   Synthèse de la journée : objectif TEU, rotations, incidents, alertes,
   détail par prestataire, pointages et camions les plus en panne.
   ===================================================================== */

/** Écran Tableau de bord. */
function viewBord() {
  const d = S.day;
  const progs = all("programmes").filter((p) => p.date === d);
  const voy = all("voyages").filter((v) => v.date === d);
  const obj = +S.settings.objTeu || 0;
  const teu = voy.filter(vyCompteObj).reduce((s, v) => s + teuT(v.taille), 0);
  const prevu = progs.reduce((s, p) => s + progVol(p), 0);
  const real = voy.filter(rotOK).length;
  const inc = voy.reduce((s, v) => s + (v.incidents || []).length, 0);
  const incOpen = voy.reduce((s, v) => s + (v.incidents || []).filter((x) => !x.tsInterv).length, 0);
  const pts = all("pointages").filter((p) => dayOfISO(p.ts) === d);
  const nonSortis = voy.filter((v) => v.sorti && v.sorti !== "Sorti").length;
  const rows = PRESTATAIRES.map((pr) => {
    const P = progs.filter((p) => p.prestataire === pr);
    const V = voy.filter((v) => v.prestataire === pr);
    const f = flotteDuJour(pr, d);
    return {
      pr,
      cam: P.reduce((s, p) => s + progCam(p), 0),
      vol: P.reduce((s, p) => s + progVol(p), 0),
      real: V.filter(rotOK).length,
      cours: V.filter((v) => {
        const st = vyStatus(v);
        return st === "cours" || st === "attente";
      }).length,
      teu: V.filter(vyCompteObj).reduce((s, v) => s + teuT(v.taille), 0),
      f,
      conf: P.length ? P.every((p) => p.confirm) : null,
      inc: V.reduce((s, v) => s + (v.incidents || []).length, 0),
      ret: retraitsActifs(pr).length
    };
  }).filter((x) => x.cam || x.vol || x.real || x.cours || x.f);
  const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const alerts = [];
  PRESTATAIRES.forEach((pr) => {
    const P = progs.filter((p) => p.prestataire === pr);
    if (!P.length) return;
    const f = flotteDuJour(pr, d);
    if (!f) alerts.push(`${pr} : flotte non déclarée`);
    else if (P.reduce((s, p) => s + progCam(p), 0) > (+f.dispoReelle || 0))
      alerts.push(`${pr} : camions demandés supérieurs à la disponibilité déclarée`);
    if (P.some((p) => !p.confirm && !p.closed)) alerts.push(`${pr} : ordre non confirmé`);
  });
  if (incOpen) alerts.push(`${incOpen} incident(s) sans reprise`);
  return `<h1 class="page">Tableau de bord</h1>${dayBar()}
    ${alerts.length ? `<div class="banner">${alerts.map(esc).join("<br>")}</div>` : ""}
    <div class="kpis">
      <div class="kpi"><div class="n">${teu}<small> / ${obj} TEU</small></div><div class="l">Pleins sortis de CT</div><div class="bar ${teu >= obj && obj ? "ok" : ""}"><div style="width:${pct(teu, obj)}%"></div></div></div>
      <div class="kpi"><div class="n">${real}<small> / ${prevu}</small></div><div class="l">Rotations réalisées</div><div class="bar ${real >= prevu && prevu ? "ok" : ""}"><div style="width:${pct(real, prevu)}%"></div></div></div>
      <div class="kpi"><div class="n">${voy.length - real - nonSortis}</div><div class="l">Camions en cours</div></div>
      <div class="kpi"><div class="n">${inc}${incOpen ? `<small> dont ${incOpen} en cours</small>` : ""}</div><div class="l">Incidents</div></div></div>
    <h2 class="sec">Par prestataire</h2>
    ${
      rows.length
        ? `<div class="tbwrap"><table class="tb"><tr><th>Prestataire</th><th class="n">Dispo</th><th class="n">Demandés</th><th class="n">Rotations</th><th class="n">En cours</th><th class="n">TEU</th><th>Ordre</th><th class="n">Pannes</th></tr>
      ${rows
        .map(
          (x) => `<tr><td><b>${x.pr}</b>${x.ret ? `<br><span class="small muted">${x.ret} retiré(s)</span>` : ""}</td>
        <td class="n">${x.f ? `${x.f.dispoReelle || 0}/${x.f.flotte || 0}${flotteLate(x.f) ? ` <span class="pill err">${hm(x.f.declaredAt)}</span>` : ""}` : `<span class="pill grey">—</span>`}</td>
        <td class="n">${x.cam}${x.f && x.cam > (+x.f.dispoReelle || 0) ? ` <span class="pill err">!</span>` : ""}</td><td class="n">${x.real} / ${x.vol}</td><td class="n">${x.cours}</td><td class="n">${x.teu}</td>
        <td>${x.conf === null ? "—" : x.conf ? `<span class="pill ok">confirmé</span>` : `<span class="pill warn">à confirmer</span>`}</td><td class="n">${x.inc}</td></tr>`
        )
        .join("")}</table></div>`
        : `<div class="empty">Aucune activité sur cette journée.</div>`
    }
    <div class="grid2" style="margin-top:14px">
      <div class="card"><b>Pointages du jour</b>${[
        ["Arrivées", pts.filter((p) => p.sens === "Arrivée").length],
        ["Départs", pts.filter((p) => p.sens === "Départ").length],
        ["Non rapprochés", pts.filter((p) => !ptMatched(p)).length],
        ["Non contresignés (sites)", pts.filter((p) => p.site !== SITES[0] && !p.contreSigne).length]
      ]
        .map(([k, v]) => `<div class="kv"><span class="k">${k}</span><b>${v}</b></div>`)
        .join("")}</div>
      <div class="card"><b>Camions les plus en panne (30 jours)</b>${
        topPannes()
          .map(([p, n]) => `<div class="kv"><span class="plate">${esc(p)}</span><b>${n}</b></div>`)
          .join("") || `<div class="small muted" style="margin-top:6px">Aucune panne.</div>`
      }</div></div>`;
}
/**
 * Camions ayant le plus d'incidents sur les 30 derniers jours.
 * @returns {Array<[string, number]>} paires [plaque, nombre] triées, max 6
 */
function topPannes() {
  const lim = shiftDay(today(), -30);
  const m = {};
  all("voyages")
    .filter((v) => v.date >= lim)
    .forEach((v) => {
      const n = (v.incidents || []).length;
      if (n) m[v.plaque] = (m[v.plaque] || 0) + n;
    });
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
}

/* =====================================================================
   3. RÉGLAGES (donneur d'ordre)
   Objectif TEU, codes d'accès, référentiel prestataires/flotte, contacts
   pour les notifications, export et sauvegarde.
   ===================================================================== */

/** Écran Réglages. */
function viewReglages() {
  const C = (S.settings.contacts = S.settings.contacts || {});
  C.prestataires = C.prestataires || {};
  C.sites = C.sites || {};
  return `<h1 class="page">Réglages</h1><div class="grid2"><div>
    <div class="card"><b>Objectif du jour</b><label class="f">TEU pleins sortis de CT</label><input class="in" type="number" inputmode="numeric" value="${+S.settings.objTeu || 0}" onchange="S.settings.objTeu=Math.max(0,+this.value||0);saveSettings();toast('Objectif enregistré')"></div>
    <div class="card"><b>Codes d'accès</b><p class="small muted">Chaque code ouvre directement le module correspondant : deux accès ne peuvent pas avoir le même code. Les codes sont chiffrés sur le serveur ; ils ne peuvent pas être affichés, seulement remplacés. Six chiffres recommandés.</p>
      ${[
        ["ct", "", "Donneur d'ordre (CT)"],
        ["agent", "", "Agent terrain"],
        ["hse", "", "HSE"],
        ["site", "", "Chef de site"]
      ]
        .concat(PRESTATAIRES.map((p) => ["presta", p, "Prestataire " + p]))
        .map(
          ([r, e, l]) =>
            `<div class="jal"><div class="jn">${esc(l)}</div><input class="in" style="width:110px" inputmode="numeric" maxlength="8" placeholder="nouveau" id="cd_${r}_${e}"><button class="btn soft sm" onclick="changeCode('${r}','${e}')">Changer</button></div>`
        )
        .join("")}</div>
    <div class="card"><b>Prestataires et camions</b><p class="small muted">Liste utilisée dans tous les menus de l'application. Une plaque par ligne. Un nouveau prestataire doit ensuite recevoir son code dans la carte « Codes d'accès ».</p>
      ${PRESTATAIRES.map((p, i) => `<label class="f">${esc(p)} · ${(FLEET[p] || []).length} camion(s)</label><textarea class="in mono" rows="3" onchange="setPlates(${i},this.value)">${esc((FLEET[p] || []).join("\n"))}</textarea><button class="btn ghost sm" style="color:var(--err)" onclick="rmPresta(${i})">Retirer ${esc(p)} de la liste</button>`).join("")}
      <div class="row" style="margin-top:12px;gap:8px"><input class="in" id="np_name" placeholder="Nom du nouveau prestataire" style="text-transform:uppercase"><button class="btn soft" style="flex:0 0 auto" onclick="addPresta()">Ajouter</button></div></div>
    <div class="card"><b>Export des données</b><div class="row"><div><label class="f">Du</label><input class="in" type="date" id="ex_from" value="${shiftDay(today(), -6)}"></div><div><label class="f">Au</label><input class="in" type="date" id="ex_to" value="${today()}"></div></div>
      <button class="btn block" style="margin-top:12px" onclick="exportXLSX()">⬇️ Exporter en Excel</button>
      <button class="btn sec block" style="margin-top:8px" onclick="backupJSON()">💾 Sauvegarde complète (fichier JSON)</button>
      <p class="small muted">À faire une fois par mois et à ranger sur OneDrive : copie de toutes les données, réglages et référentiels.</p></div></div>
    <div><div class="card"><b>Contacts prestataires</b><p class="small muted">Utilisés pour les notifications d'ordres.</p>
      ${PRESTATAIRES.map((p) => {
        const c = C.prestataires[p] || {};
        return `<label class="f">${p}</label><div class="row"><input class="in" type="email" placeholder="e-mail" value="${esc(c.email || "")}" onchange="setContact('prestataires','${p}','email',this.value)"><input class="in" type="tel" placeholder="téléphone" value="${esc(c.tel || "")}" onchange="setContact('prestataires','${p}','tel',this.value)"></div>`;
      }).join("")}</div>
    <div class="card"><b>Chefs de site</b>${Object.keys(SITE_KEYS)
      .map((k) => {
        const c = C.sites[k] || {};
        return `<label class="f">${esc(SITE_KEYS[k])}</label><div class="row"><input class="in" placeholder="nom" value="${esc(c.nom || "")}" onchange="setContact('sites','${k}','nom',this.value)"><input class="in" type="tel" placeholder="téléphone" value="${esc(c.tel || "")}" onchange="setContact('sites','${k}','tel',this.value)"></div>`;
      })
      .join("")}</div></div></div>`;
}
/**
 * Remplace la liste de camions d'un prestataire depuis un texte libre
 * (une plaque par ligne, virgules et points-virgules acceptés), puis publie
 * le référentiel à tous les appareils.
 */
function setPlates(i, txt) {
  const p = PRESTATAIRES[i];
  if (!p) return;
  FLEET[p] = [
    ...new Set(
      txt
        .split(/[\n,;]+/)
        .map((x) => x.toUpperCase().trim())
        .filter(Boolean)
    )
  ];
  saveRef();
  render();
  toast("Camions de " + p + " enregistrés");
}
/** Ajoute un prestataire au référentiel (nom en majuscules, sans accents). */
function addPresta() {
  const n = (($("np_name") || {}).value || "")
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9 -]/g, "");
  if (!n) {
    toast("Indique le nom", true);
    return;
  }
  if (PRESTATAIRES.indexOf(n) >= 0) {
    toast(n + " est déjà dans la liste", true);
    return;
  }
  PRESTATAIRES.push(n);
  FLEET[n] = FLEET[n] || [];
  saveRef();
  render();
  toast(n + " ajouté : donne-lui un code dans « Codes d'accès »");
}
/** Retire un prestataire des listes (les données passées sont conservées). */
function rmPresta(i) {
  const p = PRESTATAIRES[i];
  if (
    !p ||
    !confirm(
      "Retirer " +
        p +
        " des listes ? Ses données passées sont conservées, son code reste actif tant qu'il n'est pas changé."
    )
  )
    return;
  PRESTATAIRES.splice(i, 1);
  saveRef();
  render();
  toast(p + " retiré de la liste");
}
/** Télécharge une sauvegarde JSON complète (données, réglages, référentiels). */
function backupJSON() {
  const b = new Blob(
    [
      JSON.stringify({
        application: "Transferts CT",
        version: VERSION,
        date: nowISO(),
        donnees: S.data,
        reglages: S.settings,
        referentiels: currentRef()
      })
    ],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = "sauvegarde_transferts_ct_" + today() + ".json";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  toast("Sauvegarde téléchargée");
}
/**
 * Enregistre un contact.
 * @param {"prestataires"|"sites"} g groupe de contacts
 * @param {string} k clé du groupe (nom du prestataire ou code site)
 * @param {string} f champ (email, tel, nom)
 */
function setContact(g, k, f, v) {
  const C = S.settings.contacts;
  C[g][k] = Object.assign(C[g][k] || {}, { [f]: v.trim() });
  saveSettings();
  toast("Contact enregistré");
}
/**
 * Remplace le code d'accès d'un module (tct_set_code). Le serveur conserve
 * uniquement l'empreinte bcrypt : un code ne peut jamais être relu.
 * @param {string} r rôle concerné
 * @param {string} e entité (nom du prestataire ou "" pour CT/HSE/agents)
 */
async function changeCode(r, e) {
  const el = $("cd_" + r + "_" + e);
  const v = (el.value || "").trim();
  if (!/^[0-9]{4,8}$/.test(v)) {
    toast("Le code doit compter 4 à 8 chiffres", true);
    return;
  }
  if (
    !confirm(
      "Remplacer le code « " + (e || ROLES[r].label) + " » ? Les personnes concernées devront utiliser le nouveau code."
    )
  )
    return;
  try {
    await rpc("tct_set_code", { p_token: S.session.token, p_role: r, p_entity: e, p_code: v });
    el.value = "";
    toast("Code modifié");
  } catch (err) {
    toast(errMsg(err), true);
  }
}

/* =====================================================================
   4. EXPORT
   Génère un classeur Excel côté navigateur (bibliothèque XLSX chargée par
   le template). Un prestataire n'exporte que ses propres données.
   ===================================================================== */

/** Écran Export du prestataire : choix de la période et bouton Excel. */
function viewExport() {
  return `<h1 class="page">Export</h1><div class="card" style="max-width:520px"><b>Mes données · ${esc(ent())}</b><p class="small muted">Rotations, pointages, flotte, retraits, pannes et synthèse par camion.</p>
  <div class="row"><div><label class="f">Du</label><input class="in" type="date" id="ex_from" value="${shiftDay(today(), -6)}"></div><div><label class="f">Au</label><input class="in" type="date" id="ex_to" value="${today()}"></div></div>
  <button class="btn block" style="margin-top:12px" onclick="exportXLSX()">⬇️ Exporter en Excel</button></div>`;
}
/**
 * Construit et télécharge le classeur Excel : Rotations, Pointages, Flotte,
 * Retraits, Incidents, Ordres, puis Convois + Synthèse TEU (CT) ou
 * Rotations par camion (prestataire).
 */
function exportXLSX() {
  if (typeof XLSX === "undefined") {
    toast("Module Excel non chargé (réseau ?)", true);
    return;
  }
  const mine = role() === "presta" ? ent() : null;
  const from = $("ex_from").value || "0000",
    to = $("ex_to").value || "9999";
  const inR = (d) => {
    d = (d || "").slice(0, 10);
    return d >= from && d <= to;
  };
  const okP = (pr) => !mine || pr === mine;
  const wb = XLSX.utils.book_new();
  const add = (n, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n);
  const voy = all("voyages")
    .filter((v) => okP(v.prestataire) && inR(v.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  add(
    "Rotations",
    [
      [
        "Date",
        "Prestataire",
        "Opération",
        "Plaque",
        "Taille",
        "TEU",
        "Compte objectif",
        "Sortie",
        ...JALONS,
        "Facturable",
        "Type facturé",
        "Nb pannes",
        "Créée par"
      ]
    ].concat(
      voy.map((v) => {
        const F = vyFactu(v);
        return [
          v.date,
          v.prestataire,
          v.operation,
          v.plaque,
          v.taille,
          teuT(v.taille),
          vyCompteObj(v) ? "oui" : "non",
          v.sorti || "",
          ...JALONS.map((j) => hm((v.jalons || {})[j])),
          F.facturable ? "oui" : "non",
          F.type,
          (v.incidents || []).length,
          v.operateur || ""
        ];
      })
    )
  );
  const pts = all("pointages")
    .filter((p) => okP(p.prestataire) && inR(dayOfISO(p.ts)))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  add(
    "Pointages",
    [
      [
        "Date",
        "Heure",
        "Sens",
        "État",
        "Conteneur",
        "Conteneur 2",
        "Plomb",
        "Plomb 2",
        "Plaque",
        "Prestataire",
        "Site",
        "Taille",
        "TEU",
        "Armateur",
        "Rapproché",
        "Contresigné",
        "Photos",
        "Pointé par"
      ]
    ].concat(
      pts.map((p) => [
        dayOfISO(p.ts),
        hm(p.ts),
        p.sens,
        p.etat,
        p.conteneur,
        p.conteneur2 || "",
        p.plomb || "",
        p.plomb2 || "",
        p.plaque || "",
        p.prestataire,
        p.site,
        p.taille,
        teuT(p.taille),
        p.armateur || "",
        ptMatched(p) ? "oui" : "non",
        p.contreSigne ? "oui" : "non",
        Object.keys(p.photos || {}).length,
        p.operateur || ""
      ])
    )
  );
  add(
    "Flotte",
    [["Date", "Prestataire", "Flotte", "Réellement dispo", "Affectation", "Déclarée à", "Après 8 h"]].concat(
      all("flotte")
        .filter((f) => okP(f.prestataire) && inR(f.date))
        .map((f) => [
          f.date,
          f.prestataire,
          f.flotte,
          f.dispoReelle,
          f.affectation || "",
          hm(f.declaredAt),
          flotteLate(f) ? "oui" : "non"
        ])
    )
  );
  add(
    "Retraits",
    [["Prestataire", "Plaque", "Motif", "Précision", "Retiré le", "Remis en service le"]].concat(
      all("retraits")
        .filter((x) => okP(x.prestataire) && inR(x.ts))
        .map((x) => [x.prestataire, x.plaque, x.motif, x.note || "", dhm(x.ts), x.fin ? dhm(x.fin) : ""])
    )
  );
  add(
    "Incidents",
    [
      [
        "Date",
        "Prestataire",
        "Plaque",
        "Opération",
        "Type",
        "Description",
        "Heure",
        "Reprise",
        "Durée (min)",
        "Déclaré par"
      ]
    ].concat(
      [].concat(
        ...voy.map((v) =>
          (v.incidents || []).map((x) => [
            v.date,
            v.prestataire,
            v.plaque,
            v.operation,
            x.type,
            x.desc || "",
            hm(x.tsIncident),
            hm(x.tsInterv),
            mins(x.tsIncident, x.tsInterv),
            x.operateur || ""
          ])
        )
      )
    )
  );
  add(
    "Ordres",
    [
      [
        "Date",
        "Prestataire",
        "Site",
        "Opération",
        "Camions prévus",
        "Rotations prévues",
        "Camions affectés",
        "Remarque",
        "Confirmé"
      ]
    ].concat(
      [].concat(
        ...all("programmes")
          .filter((p) => okP(p.prestataire) && inR(p.date))
          .map((p) =>
            progLignes(p).map((l) => [
              p.date,
              p.prestataire,
              l.site,
              l.operation,
              +l.camions || 0,
              +l.volume || 0,
              +l.realise || 0,
              l.realNote || "",
              p.confirm ? "oui" : "non"
            ])
          )
      )
    )
  );
  if (!mine) {
    add(
      "Convois",
      [
        [
          "Date",
          "Camions",
          "GA dépôt",
          "GA signée",
          "Délai GA",
          "CP dépôt",
          "CP signée",
          "Délai CP",
          "Signé",
          "Escorte",
          "Escorte arrivée",
          "Douane appel",
          "Douane arrivée",
          "Délai douane",
          "HSE appel",
          "HSE arrivée",
          "Délai HSE",
          "TBM début",
          "TBM fin",
          "TBM fait",
          "Départ",
          "Arrivée Kagbélen",
          "Temps de route"
        ]
      ].concat(
        all("convois")
          .filter((c) => inR(c.date))
          .map((c) => [
            c.date,
            c.nbCamions || 0,
            hm(c.gaDepot),
            hm(c.gaRecep),
            mins(c.gaDepot, c.gaRecep),
            hm(c.cpDepot),
            hm(c.cpRecep),
            mins(c.cpDepot, c.cpRecep),
            c.signe ? "oui" : "non",
            c.escNb || 0,
            hm(c.escArr),
            hm(c.appelDou),
            hm(c.arrDou),
            mins(c.appelDou, c.arrDou),
            hm(c.appelHse),
            hm(c.arrHse),
            mins(c.appelHse, c.arrHse),
            hm(c.tbmDebut),
            hm(c.tbmFin),
            c.tbmFait ? "oui" : "non",
            hm(c.depart),
            hm(c.arrKag),
            mins(c.depart, c.arrKag)
          ])
      )
    );
    const T = {};
    voy.forEach((v) => {
      if (vyCompteObj(v)) T[v.date] = (T[v.date] || 0) + teuT(v.taille);
    });
    const obj = +S.settings.objTeu || 0;
    add(
      "Synthese_TEU",
      [["Date", "TEU pleins sortis de CT", "Objectif", "Écart"]].concat(
        Object.keys(T)
          .sort()
          .map((d) => [d, T[d], obj, T[d] - obj])
      )
    );
  } else {
    const R = {};
    voy.forEach((v) => {
      if (rotOK(v)) R[v.plaque] = (R[v.plaque] || 0) + 1;
    });
    add(
      "Rotations_par_camion",
      [["Plaque", "Rotations réalisées"]].concat(Object.entries(R).sort((a, b) => b[1] - a[1]))
    );
  }
  XLSX.writeFile(wb, "transferts_" + (mine ? mine + "_" : "") + from + "_" + to + ".xlsx");
  toast("Fichier Excel généré");
}

/* =====================================================================
   5. DÉMARRAGE
   Dernier fichier chargé : le DOM et tous les modules sont prêts.
   ===================================================================== */

render();
if (S.session) syncNow();
