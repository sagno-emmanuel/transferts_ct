/* =====================================================================
   Transferts CT — ORDRES, PROGRAMME ET FLOTTE
   =====================================================================
   Chargé après core.js et shell.js. Un « programme » (type `programmes`)
   est l'ordre donné à un prestataire pour une journée : une liste de
   chantiers (`lignes`), chacun avec un site, une opération, un nombre de
   camions et un nombre de rotations prévus. Il porte aussi un journal des
   changements, un état de confirmation et une date de notification.

   Trois lectures du même objet :
     - Ordres     : le CT crée, modifie, notifie et clôture.
     - Programme  : le prestataire confirme et affecte ses camions ; le chef
                    de site ne voit que les chantiers de son site.
     - Flotte     : le prestataire déclare ses camions disponibles du jour et
                    retire ceux qui sont immobilisés (type `retraits`).
   ===================================================================== */

/* ---------------------------------------------------------------------
   ORDRES (donneur d'ordre)
   ------------------------------------------------------------------- */

/** Programmes de la journée affichée, triés dans l'ordre des prestataires. */
function ordresDuJour() {
  return all("programmes")
    .filter((p) => p.date === S.day)
    .sort((a, b) => PRESTATAIRES.indexOf(a.prestataire) - PRESTATAIRES.indexOf(b.prestataire));
}
/** Nombre de rotations terminées (retour à CT) pour ce programme. */
function rotRealisees(p) {
  return all("voyages").filter((v) => v.date === p.date && v.prestataire === p.prestataire && rotOK(v)).length;
}
/**
 * Écran Ordres : les ordres du jour et, pour les prestataires qui n'en ont
 * pas encore, un bouton de création (avec le nombre de camions disponibles
 * s'ils ont déclaré leur flotte).
 */
function viewOrdres() {
  const l = ordresDuJour();
  const sans = PRESTATAIRES.filter((pr) => !l.find((p) => p.prestataire === pr));
  return `<h1 class="page">Ordres</h1>${dayBar()}
    ${l.length ? `<div class="grid2">${l.map(ordreCard).join("")}</div>` : `<div class="empty">Aucun ordre pour cette journée.</div>`}
    ${
      sans.length && S.day >= today()
        ? `<h2 class="sec">Créer un ordre</h2><div class="chips" style="flex-wrap:wrap">${sans
            .map((pr) => {
              const f = flotteDuJour(pr, S.day);
              return `<button onclick="newOrdre('${pr}')">＋ ${pr}${f ? ` · ${f.dispoReelle || 0} dispo` : ""}</button>`;
            })
            .join("")}</div>`
        : ""
    }`;
}
/** Carte d'un ordre : chantiers, flotte disponible, avancement, actions. */
function ordreCard(p) {
  const cam = progCam(p),
    vol = progVol(p),
    done = rotRealisees(p);
  const f = flotteDuJour(p.prestataire, p.date);
  const dispo = f ? +f.dispoReelle || 0 : null;
  const sk = [
    ...new Set(
      progLignes(p)
        .map((l) => siteOf(l.site) || siteOf(l.operation))
        .filter(Boolean)
    )
  ];
  return `<div class="item"><div class="between"><span class="t">${esc(p.prestataire)}</span><span>${p.closed ? `<span class="pill grey">Clôturé</span>` : p.confirm ? `<span class="pill ok">Confirmé</span>` : `<span class="pill warn">À confirmer</span>`}${p.notifiedAt ? ` <span class="pill info">Notifié ${hm(p.notifiedAt)}</span>` : ""}</span></div>
    ${
      progLignes(p)
        .map(
          (l) =>
            `<div class="s">• ${esc(l.site)} — ${esc(opShort(l.operation))} : <b>${+l.camions || 0}</b> cam. · <b>${+l.volume || 0}</b> rot.${l.realise ? ` · affectés ${+l.realise}` : ""}${l.realNote ? ` · ${esc(l.realNote)}` : ""}</div>`
        )
        .join("") || `<div class="s">Aucun chantier.</div>`
    }
    <div class="s" style="margin-top:6px">Camions ${cam}${dispo != null ? ` / ${dispo} dispo ${cam > dispo ? `<span class="pill err">dépassement</span>` : ""}` : ` <span class="pill grey">flotte non déclarée</span>`} · Rotations ${done} / ${vol}</div>
    <div class="bar ${vol && done >= vol ? "ok" : ""}"><div style="width:${vol ? Math.min(100, Math.round((done / vol) * 100)) : 0}%"></div></div>
    <div class="acts"><button class="btn sec" onclick="editOrdre('${p.id}')">Modifier</button><button class="btn accent" onclick="notifySheet('${p.id}')">Notifier</button>
      <button class="btn ${p.closed ? "sec" : "soft"}" onclick="toggleClose('${p.id}')">${p.closed ? "Rouvrir" : "Clôturer"}</button></div></div>`;
}
/** Crée un ordre vide pour un prestataire et ouvre directement sa feuille. */
function newOrdre(pr) {
  const p = {
    id: uid(),
    date: S.day,
    prestataire: pr,
    lignes: [],
    confirm: false,
    notifiedAt: "",
    closed: "",
    journal: []
  };
  save("programmes", p, true);
  editOrdre(p.id);
}
/** Clôture un ordre (ou le rouvre s'il était clôturé). */
function toggleClose(id) {
  const p = get("programmes", id);
  p.closed = p.closed ? "" : nowISO();
  save("programmes", p);
  toast(p.closed ? "Ordre clôturé" : "Ordre rouvert");
}
/** Ouvre la feuille de modification d'un ordre, rafraîchie après chaque édition. */
function editOrdre(id) {
  const draw = () => {
    const p = get("programmes", id);
    if (!p) {
      closeSheet();
      return;
    }
    sheetHTML(ordreHTML(p));
  };
  openSheet(ordreHTML(get("programmes", id)), null, draw);
}
/**
 * Contenu de la feuille d'un ordre : rappel de la flotte déclarée, chantiers
 * modifiables, ajout d'un chantier, journal et actions de fin.
 */
function ordreHTML(p) {
  const f = flotteDuJour(p.prestataire, p.date);
  const cam = progCam(p);
  const dispo = f ? +f.dispoReelle || 0 : null;
  const ret = retraitsActifs(p.prestataire);
  return `<div class="between"><h3>${esc(p.prestataire)} · ${esc(dayLabel(p.date))}</h3><button class="btn ghost" onclick="closeSheet()">Fermer</button></div>
    <div class="banner" style="margin-top:6px">${f ? `Flotte déclarée à ${hm(f.declaredAt)}${flotteLate(f) ? " (après 8 h)" : ""} : <b>${f.dispoReelle || 0}</b> réellement disponibles sur ${f.flotte || 0}. Affectés ici : <b>${cam}</b>${dispo != null && cam > dispo ? " — dépassement" : ""}.` : "Le prestataire n'a pas encore déclaré sa flotte pour cette journée."}${ret.length ? ` ${ret.length} camion(s) retiré(s) du service.` : ""}</div>
    <h2 class="sec">Chantiers</h2>
    ${
      progLignes(p)
        .map(
          (
            l,
            i
          ) => `<div class="card tight"><div class="between"><b>${esc(l.site)}</b><button class="btn ghost sm" style="color:var(--err)" onclick="rmLigne('${p.id}',${i})">Retirer</button></div>
      <div class="small muted">${esc(l.operation)}</div>
      <div class="row"><div><label class="f">Camions</label><input class="in" type="number" inputmode="numeric" min="0" value="${+l.camions || 0}" onchange="setLigne('${p.id}',${i},'camions',this.value)"></div>
      <div><label class="f">Rotations</label><input class="in" type="number" inputmode="numeric" min="0" value="${+l.volume || 0}" onchange="setLigne('${p.id}',${i},'volume',this.value)"></div></div>
      ${l.realise || l.realNote ? `<div class="small muted" style="margin-top:6px">Prestataire : ${+l.realise || 0} camion(s) affecté(s)${l.realNote ? " · " + esc(l.realNote) : ""}</div>` : ""}</div>`
        )
        .join("") || `<div class="small muted">Aucun chantier pour l'instant.</div>`
    }
    <div class="card tight" style="background:#f7fafc"><b>Ajouter un chantier</b>
      <label class="f">Site</label><select class="in" id="ol_site">${opts(SITES)}</select>
      <label class="f">Opération</label><select class="in" id="ol_op">${opts(OPERATIONS)}</select>
      <div class="row"><div><label class="f">Camions</label><input class="in" id="ol_cam" type="number" inputmode="numeric" min="0" placeholder="0"></div><div><label class="f">Rotations</label><input class="in" id="ol_vol" type="number" inputmode="numeric" min="0" placeholder="0"></div></div>
      <button class="btn soft block" style="margin-top:10px" onclick="addLigne('${p.id}')">＋ Ajouter</button></div>
    ${journalHTML(p)}
    <div class="btns" style="margin-top:14px"><button class="btn ghost" style="color:var(--err);flex:0 0 auto" onclick="if(confirm('Supprimer cet ordre ?')){remove('programmes','${p.id}');closeSheet();}">Supprimer</button><button class="btn" onclick="closeSheet()">Terminé</button></div>`;
}
/** Ajoute le chantier saisi en bas de la feuille et le note au journal. */
function addLigne(id) {
  const p = get("programmes", id);
  const site = $("ol_site").value;
  p.lignes = progLignes(p).concat([
    {
      site,
      operation: $("ol_op").value,
      camions: Math.max(0, Math.round(+$("ol_cam").value || 0)),
      volume: Math.max(0, Math.round(+$("ol_vol").value || 0)),
      realise: 0,
      realNote: ""
    }
  ]);
  p.confirm = false;
  pushJournal(p, "Chantier ajouté : " + site);
  save("programmes", p);
  toast("Chantier ajouté");
}
/** Retire un chantier et le note au journal. */
function rmLigne(id, i) {
  const p = get("programmes", id);
  const l = p.lignes[i];
  p.lignes.splice(i, 1);
  p.confirm = false;
  pushJournal(p, "Chantier retiré : " + (l ? l.site : ""));
  save("programmes", p);
}
/**
 * Modifie un nombre d'un chantier (camions ou rotations), en le bornant à 0.
 * Toute modification annule la confirmation du prestataire et alimente le journal.
 */
function setLigne(id, i, k, val) {
  const p = get("programmes", id);
  const old = +p.lignes[i][k] || 0;
  p.lignes[i][k] = Math.max(0, Math.round(+val || 0));
  p.confirm = false;
  if (old !== p.lignes[i][k])
    pushJournal(
      p,
      p.lignes[i].site + " : " + (k === "camions" ? "camions" : "rotations") + " " + old + " → " + p.lignes[i][k]
    );
  save("programmes", p);
}
/** Ajoute une entrée en tête du journal d'un ordre (auteur, heure, texte). */
function pushJournal(p, text) {
  p.journal = Array.isArray(p.journal) ? p.journal : [];
  p.journal.unshift({
    ts: nowISO(),
    who: (role() === "presta" ? "Prestataire " + ent() : ROLES[role()].label) + " (" + oper() + ")",
    text
  });
}
/** Bloc HTML du journal : saisie libre + 15 dernières entrées. */
function journalHTML(p) {
  const j = Array.isArray(p.journal) ? p.journal : [];
  return `<h2 class="sec">Journal des changements</h2><div class="row" style="gap:8px"><input class="in" id="jr_${p.id}" placeholder="ex. 11h : +2 camions sur Kagbélen"><button class="btn soft" style="flex:0 0 auto" onclick="addJournal('${p.id}')">Noter</button></div>
    <div style="margin-top:8px">${
      j
        .slice(0, 15)
        .map(
          (e) => `<div class="small" style="padding:4px 0">${dhm(e.ts)} · <b>${esc(e.who)}</b> : ${esc(e.text)}</div>`
        )
        .join("") || `<div class="small muted">Aucun changement noté.</div>`
    }</div>`;
}
/** Ajoute la note libre saisie dans le journal de l'ordre. */
function addJournal(id) {
  const p = get("programmes", id);
  const el = $("jr_" + id);
  const t = el ? el.value.trim() : "";
  if (!t) return;
  pushJournal(p, t);
  if (role() !== "presta") p.confirm = false;
  save("programmes", p);
  toast("Noté au journal");
}
/** Contacts enregistrés d'un prestataire ({email, tel}) — Réglages. */
function contactsP(pr) {
  return ((S.settings.contacts || {}).prestataires || {})[pr] || {};
}
/** Contacts enregistrés d'un chef de site ({tel}) — Réglages. */
function contactsS(sk) {
  return ((S.settings.contacts || {}).sites || {})[sk] || {};
}
/** Feuille de notification : e-mail, SMS ou SMS de mise à jour, plus les chefs de site concernés. */
function notifySheet(id) {
  const p = get("programmes", id);
  const c = contactsP(p.prestataire);
  const sk = [
    ...new Set(
      progLignes(p)
        .map((l) => siteOf(l.site) || siteOf(l.operation))
        .filter(Boolean)
    )
  ];
  openSheet(`<h3>Notifier · ${esc(p.prestataire)}</h3><p class="small muted">Le message s'ouvre dans ta messagerie, prêt à envoyer.</p>
    <div class="btns"><button class="btn accent" ${c.email ? "" : "disabled"} onclick="notify('${id}','mail',false)">✉️ E-mail</button><button class="btn accent" ${c.tel ? "" : "disabled"} onclick="notify('${id}','sms',false)">💬 SMS</button></div>
    <button class="btn sec block" style="margin-top:8px" ${c.tel ? "" : "disabled"} onclick="notify('${id}','sms',true)">🔄 SMS de mise à jour</button>
    ${!c.email && !c.tel ? `<div class="banner" style="margin-top:10px">Aucun contact pour ${esc(p.prestataire)} : à renseigner dans Réglages.</div>` : ""}
    ${sk.length ? `<h2 class="sec">Chefs de site</h2><div class="btns">${sk.map((k) => `<button class="btn soft" ${contactsS(k).tel ? "" : "disabled"} onclick="notifySite('${id}','${k}')">📍 ${esc(SITE_KEYS[k])}</button>`).join("")}</div>` : ""}`);
}
/**
 * Ouvre l'application de messagerie du téléphone avec le message prêt
 * (mailto: ou sms:) et horodate la notification.
 * @param {"mail"|"sms"} canal
 * @param {boolean} maj true pour un message de mise à jour
 */
function notify(id, canal, maj) {
  const p = get("programmes", id);
  const c = contactsP(p.prestataire);
  const L = progLignes(p);
  const M = maj ? "MISE À JOUR — " : "";
  const detail =
    L.map(
      (l) => `• ${l.site} — ${opShort(l.operation)} : ${+l.camions || 0} camion(s), ${+l.volume || 0} rotation(s)`
    ).join("\n") || "• chantiers à préciser";
  const subject = `${M}Programme du ${p.date} — ${p.prestataire}`;
  const body = `Bonjour,\n\n${maj ? "Le programme a été mis à jour.\n\n" : ""}Affectation du ${p.date} :\n${detail}\n\nTotal : ${progCam(p)} camion(s), ${progVol(p)} rotation(s).\nMerci de confirmer la prise en compte dans l'application.\n\nConakry Terminal — Service Transport`;
  const sms = `${M}Transfert CT ${p.date} (${p.prestataire}) : ${progCam(p)} camion(s), ${progVol(p)} rot. sur ${L.length} chantier(s). Merci de confirmer dans l'application.`;
  p.notifiedAt = nowISO();
  save("programmes", p, true);
  location.href =
    canal === "mail"
      ? `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
      : `sms:${c.tel}?body=${encodeURIComponent(sms)}`;
}
/** Prépare un SMS pour le chef de site `sk`, limité aux rotations de son site. */
function notifySite(id, sk) {
  const p = get("programmes", id);
  const c = contactsS(sk);
  const L = progLignes(p).filter((l) => (siteOf(l.site) || siteOf(l.operation)) === sk);
  const sms = `CT ${p.date} : ${p.prestataire}, ${L.reduce((s, l) => s + (+l.volume || 0), 0)} rotation(s) prévue(s) sur ${SITE_KEYS[sk]}.`;
  location.href = `sms:${c.tel}?body=${encodeURIComponent(sms)}`;
}

/* =====================================================================
   PROGRAMME (prestataire, agent CT, chef de site)
   Même données que les ordres, vues par ceux qui les exécutent.
   ===================================================================== */

/** Écran Programme : ordres reçus (prestataire) ou flux prévus (site). */
function viewProgramme() {
  const r = role();
  let l = all("programmes").filter((p) => p.date === S.day);
  if (r === "presta") l = l.filter((p) => p.prestataire === ent());
  if (r === "site") l = l.filter((p) => progLignes(p).some((x) => (siteOf(x.site) || siteOf(x.operation)) === ent()));
  const title = r === "presta" ? "Ordres reçus" : r === "site" ? "Flux prévus" : "Programme";
  return `<h1 class="page">${title}</h1>${dayBar()}
    ${l.length ? `<div class="grid2">${l.map((p) => progCard(p)).join("")}</div>` : `<div class="empty">${r === "presta" ? "Aucun ordre reçu pour cette journée." : "Aucun programme pour cette journée."}</div>`}`;
}
/** Carte d'un programme ; le prestataire y saisit ses camions affectés et confirme. */
function progCard(p) {
  const r = role();
  const isP = r === "presta";
  let L = progLignes(p);
  if (r === "site") L = L.filter((x) => (siteOf(x.site) || siteOf(x.operation)) === ent());
  const done = rotRealisees(p);
  const vol = L.reduce((s, l) => s + (+l.volume || 0), 0);
  return `<div class="item"><div class="between"><span class="t">${esc(p.prestataire)}</span>${p.closed ? `<span class="pill grey">Clôturé</span>` : p.confirm ? `<span class="pill ok">Confirmé</span>` : `<span class="pill warn">À confirmer</span>`}</div>
    ${L.map((l) => {
      const gi = progLignes(p).indexOf(l);
      return `<div class="card tight" style="margin:8px 0 0"><b>${esc(l.site)}</b><div class="small muted">${esc(opShort(l.operation))} · prévu ${+l.camions || 0} camion(s), ${+l.volume || 0} rotation(s)</div>
      ${
        isP && !p.closed
          ? `<div class="row"><div><label class="f">Camions affectés</label><input class="in" type="number" inputmode="numeric" min="0" value="${+l.realise || 0}" onchange="setReal('${p.id}',${gi},'realise',this.value)"></div>
        <div><label class="f">Remarque</label><input class="in" value="${esc(l.realNote || "")}" placeholder="optionnel" onchange="setReal('${p.id}',${gi},'realNote',this.value)"></div></div>`
          : l.realise
            ? `<div class="small">Affectés par le prestataire : <b>${+l.realise}</b>${l.realNote ? " · " + esc(l.realNote) : ""}</div>`
            : ""
      }</div>`;
    }).join("")}
    <div class="s" style="margin-top:8px">Rotations réalisées ${done} / ${vol}</div>
    ${isP && !p.closed ? `<div class="acts">${p.confirm ? `<button class="btn sec" onclick="confirmProg('${p.id}')">✓ Confirmé · annuler</button>` : `<button class="btn ok" onclick="confirmProg('${p.id}')">Confirmer la prise en compte</button>`}<button class="btn soft" style="flex:0 0 auto" onclick="journalSheet('${p.id}')">Journal</button></div>` : ""}</div>`;
}
/** Enregistre l'affectation réelle du prestataire sur un chantier (camions, remarque). */
function setReal(id, i, k, val) {
  const p = get("programmes", id);
  p.lignes[i][k] = k === "realise" ? Math.max(0, Math.round(+val || 0)) : val;
  save("programmes", p);
}
/** Bascule la confirmation de prise en compte d'un ordre par le prestataire. */
function confirmProg(id) {
  const p = get("programmes", id);
  p.confirm = !p.confirm;
  if (p.confirm) pushJournal(p, "Ordre confirmé");
  save("programmes", p);
  toast(p.confirm ? "Ordre confirmé" : "Confirmation retirée");
}
/** Feuille du journal d'un ordre, en lecture et ajout de notes. */
function journalSheet(id) {
  const draw = () =>
    sheetHTML(
      `<div class="between"><h3>Journal</h3><button class="btn ghost" onclick="closeSheet()">Fermer</button></div>` +
        journalHTML(get("programmes", id))
    );
  openSheet(
    `<div class="between"><h3>Journal</h3><button class="btn ghost" onclick="closeSheet()">Fermer</button></div>` +
      journalHTML(get("programmes", id)),
    null,
    draw
  );
}

/* =====================================================================
   FLOTTE (prestataire)
   Déclaration quotidienne de la disponibilité et retraits temporaires.
   ===================================================================== */

/**
 * Écran Ma flotte : déclaration du jour, camions retirés et historique des
 * 15 dernières déclarations.
 */
function viewFlotte() {
  const pr = ent();
  const d = today();
  const cur = flotteDuJour(pr, d) || {};
  const ret = retraitsActifs(pr);
  const hist = all("flotte")
    .filter((f) => f.prestataire === pr)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 15);
  return `<h1 class="page">Ma flotte · ${esc(pr)}</h1>
    <div class="cols"><div>
    <div class="card"><div class="between"><b>Disponibilité du jour</b>${cur.declaredAt ? (flotteLate(cur) ? `<span class="pill err">déclarée à ${hm(cur.declaredAt)} (après 8 h)</span>` : `<span class="pill ok">déclarée à ${hm(cur.declaredAt)}</span>`) : `<span class="pill warn">à déclarer avant 8 h</span>`}</div>
      <div class="row"><div><label class="f">Camions de la flotte</label><input class="in" id="fl_tot" type="number" inputmode="numeric" value="${cur.flotte ?? ""}" placeholder="0"></div>
        <div><label class="f">Réellement dispo</label><input class="in" id="fl_reel" type="number" inputmode="numeric" value="${cur.dispoReelle ?? ""}" placeholder="0"></div></div>
      <div class="hint">Réellement dispo : chauffeur présent, camion carburé, sans immobilisation.</div>
      <label class="f">Affectation principale</label><select class="in" id="fl_aff">${opts(["", "TAC (Conakry Terminal)", "PSK (Kagbélen)", "Parc Burkina", "Parc Kidal", "Mixte"], cur.affectation || "", ["—", "TAC (Conakry Terminal)", "PSK (Kagbélen)", "Parc Burkina", "Parc Kidal", "Mixte"])}</select>
      <button class="btn xl block" style="margin-top:14px" onclick="saveFlotte()">${cur.declaredAt ? "Mettre à jour" : "Déclarer ma flotte"}</button></div>
    <div class="card"><b>Camions retirés du service (${ret.length})</b>
      ${ret.map((x) => `<div class="kv"><span><span class="plate">${esc(x.plaque)}</span> <span class="pill err">${esc(x.motif)}</span><br><span class="small muted">depuis ${dhm(x.ts)}${x.note ? " · " + esc(x.note) : ""}</span></span><button class="btn soft sm" onclick="remiseService('${x.id}')">Remettre en service</button></div>`).join("") || `<div class="small muted" style="margin-top:6px">Aucun.</div>`}
      <button class="btn sec block" style="margin-top:10px" onclick="retraitSheet()">＋ Retirer un camion</button></div></div>
    <div><h2 class="sec">Historique des déclarations</h2>
      ${hist.length ? `<div class="tbwrap"><table class="tb"><tr><th>Jour</th><th class="n">Flotte</th><th class="n">Dispo</th><th>Heure</th></tr>${hist.map((f) => `<tr><td>${esc(dayLabel(f.date))}</td><td class="n">${f.flotte || 0}</td><td class="n">${f.dispoReelle || 0}</td><td>${hm(f.declaredAt)} ${flotteLate(f) ? `<span class="pill err">après 8 h</span>` : ""}</td></tr>`).join("")}</table></div>` : `<div class="empty">Aucune déclaration.</div>`}</div></div>`;
}
/**
 * Enregistre la déclaration de flotte du jour (total, réellement dispo,
 * affectation). La première déclaration garde son heure d'origine.
 */
function saveFlotte() {
  const pr = ent(),
    d = today();
  const tot = Math.max(0, Math.round(+$("fl_tot").value || 0)),
    reel = Math.max(0, Math.round(+$("fl_reel").value || 0));
  if (reel > tot && !confirm("Plus de camions disponibles que de camions dans la flotte. Enregistrer quand même ?"))
    return;
  const cur = flotteDuJour(pr, d);
  const f = cur || { id: uid(), date: d, prestataire: pr };
  Object.assign(f, {
    flotte: tot,
    dispoReelle: reel,
    dispo: reel,
    affectation: $("fl_aff").value,
    declaredAt: cur && cur.declaredAt ? cur.declaredAt : nowISO(),
    majAt: nowISO(),
    operateur: oper()
  });
  save("flotte", f);
  toast("Flotte enregistrée");
}
/** Feuille de retrait d'un camion du service (plaque, motif, précision). */
function retraitSheet() {
  openSheet(`<h3>Retirer un camion du service</h3>
  <label class="f">Camion</label><input class="in mono big" id="rt_pl" list="rt_list" placeholder="Plaque"><datalist id="rt_list">${plateOptions(ent())}</datalist>
  <label class="f">Motif</label><div class="chips" id="rt_m" style="flex-wrap:wrap">${MOTIFS_RETRAIT.map((m, i) => `<button class="${i === 0 ? "on" : ""}" onclick="segOn(this)">${m}</button>`).join("")}</div>
  <label class="f">Précision</label><textarea class="in" id="rt_n" placeholder="Optionnel"></textarea>
  <button class="btn err block" style="margin-top:14px" onclick="addRetrait()">Retirer du service</button>`);
}
/** Enregistre le retrait d'un camion (sans heure de fin). */
function addRetrait() {
  const pl = ($("rt_pl").value || "").toUpperCase().trim();
  if (!pl) {
    toast("Indique la plaque", true);
    return;
  }
  save("retraits", {
    id: uid(),
    prestataire: ent(),
    plaque: pl,
    motif: segVal("rt_m"),
    note: $("rt_n").value.trim(),
    ts: nowISO(),
    fin: "",
    operateur: oper()
  });
  closeSheet();
  toast(pl + " retiré du service");
}
/** Remet un camion en service en renseignant l'heure de fin de retrait. */
function remiseService(id) {
  const x = get("retraits", id);
  x.fin = nowISO();
  save("retraits", x);
  toast(x.plaque + " remis en service");
}
