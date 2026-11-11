/* =====================================================================
   Transferts CT — POINTAGE DES CONTENEURS
   =====================================================================
   Chargé après core.js et shell.js. Trois écrans :
     - Pointage     : saisie d'une arrivée / d'un départ (conteneur, scellés,
                      photos, plaque) + liste des pointages du jour.
     - Réception    : contresignature par le chef de site.
     - Pointages CT : vue d'ensemble filtrable pour le donneur d'ordre.

   Un pointage (type `pointages`) décrit UN conteneur (deux pour un camion
   2x20') : sens, état, taille, numéros de conteneur et de plomb, plaque,
   prestataire, site, photos et contresignature.
   ===================================================================== */

/* ---------------------------------------------------------------------
   Formulaire : état du brouillon et fonctions de saisie
   ------------------------------------------------------------------- */

// Brouillon du formulaire (conservé si l'écran se recharge ou si l'appli est fermée)
const PT = Object.assign(
  {
    sens: "Arrivée",
    etat: "Plein",
    taille: "2x20'",
    prest: PRESTATAIRES[0],
    site: SITES[0],
    cn: "",
    cn2: "",
    plomb: "",
    plomb2: "",
    plaque: "",
    arm: "MSC",
    photos: {}
  },
  LS.get("ptDraft", {})
);
// Filtres de la liste des pointages (sens, recherche texte).
const PF = { sens: "", q: "" };

/** Persiste le brouillon du formulaire dans localStorage. */
function ptSave() {
  LS.set("ptDraft", PT);
}
/** Modifie un champ du brouillon et le persiste aussitôt. */
function ptSet(k, v) {
  PT[k] = v;
  ptSave();
}
/** Tailles proposées : un plein ne se pointe qu'en 2x20' ou 40'. */
function tailleOpts(etat) {
  return etat === "Plein" ? ["2x20'", "40'"] : ["20'", "2x20'", "40'"];
}
/** true si la session est un agent de pointage rattaché à un prestataire. */
function isPointeur() {
  return role() === "pointeur";
}
/** Prestataire du pointage : imposé au pointeur, choisi sinon. */
function ptPrest() {
  return isPointeur() ? ent() : PT.prest;
}
/** Site du pointage : imposé au pointeur et à l'agent, choisi par le CT. */
function ptSite() {
  if (isPointeur()) return psite();
  if (role() === "agent") return agentSite() === "PSK" ? SITES[1] : SITES[0];
  return PT.site;
}
/**
 * Écran Pointage : formulaire (journée en cours uniquement) et liste du jour.
 * Le formulaire est prérempli par le brouillon PT ; les champs affichés
 * dépendent du sens (arrivée/départ), de l'état (plein/vide) et de la taille.
 */
function viewPointage() {
  if (tailleOpts(PT.etat).indexOf(PT.taille) < 0) PT.taille = tailleOpts(PT.etat)[0];
  const vide = PT.etat === "Vide";
  const two = PT.taille === "2x20'";
  const chk = iso6346valid(PT.cn);
  const form = `<div class="card">
    <div class="row"><div><label class="f">Sens</label><div class="seg">${["Arrivée", "Départ"].map((x) => `<button class="${PT.sens === x ? "on" : ""}" onclick="ptSet('sens','${x}');render()">${x}</button>`).join("")}</div></div>
      <div><label class="f">État</label><div class="seg">${["Plein", "Vide"].map((x) => `<button class="${PT.etat === x ? "on" : ""}" onclick="ptSet('etat','${x}');render()">${x}</button>`).join("")}</div></div></div>
    ${
      isPointeur()
        ? ""
        : `<div class="row"><div><label class="f">Prestataire</label><select class="in" onchange="ptSet('prest',this.value);render()">${opts(PRESTATAIRES, PT.prest)}</select></div>
      ${role() === "agent" ? "" : `<div><label class="f">Site</label><select class="in" onchange="ptSet('site',this.value)">${opts(SITES, PT.site)}</select></div>`}</div>`
    }
    <label class="f">N° conteneur ${PT.cn.length >= 11 ? (chk ? `<span class="pill ok">clé ISO valide</span>` : `<span class="pill warn">clé à vérifier</span>`) : ""}</label>
    <div class="row" style="gap:8px"><input class="in big mono" id="pt_cn" value="${esc(PT.cn)}" placeholder="MSCU1234567" maxlength="11" autocomplete="off" autocapitalize="characters" oninput="ptCn(this)">
      ${"BarcodeDetector" in window ? `<button class="btn soft" style="flex:0 0 auto" onclick="scanTo('cn')">📷 Scan</button>` : ""}</div>
    <label class="f">Taille</label><div class="seg">${tailleOpts(PT.etat)
      .map(
        (x, i) =>
          `<button class="${PT.taille === x ? "on" : ""}" onclick="ptSet('taille',tailleOpts(PT.etat)[${i}]);render()">${x}</button>`
      )
      .join("")}</div>
    <div class="hint">${vide ? "Vide : 20', 2x20' ou 40'." : "Plein : 2x20' (deux conteneurs sur le camion) ou 40'. Le 20' seul est réservé au vide."}</div>
    ${vide ? "" : `<label class="f">N° de plomb</label><input class="in mono" value="${esc(PT.plomb)}" oninput="ptSet('plomb',this.value)" placeholder="Scellé">`}
    <div class="photos">${phTile("c1", "Conteneur")}${vide ? "" : phTile("s1", "Scellé")}</div>
    ${
      two
        ? `<div style="border-left:3px solid var(--accent);padding-left:10px;margin-top:12px">
      <label class="f">2e conteneur</label><input class="in big mono" value="${esc(PT.cn2)}" maxlength="11" placeholder="MSCU7654321" autocapitalize="characters" oninput="this.value=this.value.toUpperCase().replace(/\\s/g,'');ptSet('cn2',this.value)">
      ${vide ? "" : `<label class="f">2e plomb</label><input class="in mono" value="${esc(PT.plomb2)}" oninput="ptSet('plomb2',this.value)" placeholder="Scellé 2">`}
      <div class="photos">${phTile("c2", "2e conteneur")}${vide ? "" : phTile("s2", "2e scellé")}</div></div>`
        : ""
    }
    <label class="f">Plaque du camion</label><input class="in mono" list="pt_pl" value="${esc(PT.plaque)}" oninput="ptSet('plaque',this.value.toUpperCase())" placeholder="Choisir ou saisir" autocomplete="off"><datalist id="pt_pl">${plateOptions(ptPrest())}</datalist>
    ${vide ? `<label class="f">Armateur</label><select class="in" onchange="ptSet('arm',this.value)">${opts(ARMATEURS, PT.arm)}</select>` : ""}
    <button class="btn xl block" style="margin-top:16px" onclick="addPointage()">✓ Enregistrer le pointage</button>
    <div class="hint center">${esc(ptPrest())} · ${esc(ptSite())}</div></div>`;
  let list = all("pointages").filter((p) => dayOfISO(p.ts) === S.day);
  if (isPointeur()) list = list.filter((p) => p.site === psite());
  else if (role() === "agent") list = list.filter((p) => p.site === ptSite());
  const nA = list.filter((p) => p.sens === "Arrivée").length,
    nD = list.length - nA;
  if (PF.sens) list = list.filter((p) => p.sens === PF.sens);
  if (PF.q) {
    const q = PF.q.toUpperCase();
    list = list.filter((p) =>
      (p.conteneur + " " + (p.conteneur2 || "") + " " + (p.plaque || "")).toUpperCase().includes(q)
    );
  }
  list.sort((a, b) => b.ts.localeCompare(a.ts));
  const lst = `<h2 class="sec">Pointés · ${esc(dayLabel(S.day))} (${nA} arrivées · ${nD} départs)</h2>
    <div class="chips">${[
      ["", "Tous"],
      ["Arrivée", "Arrivées"],
      ["Départ", "Départs"]
    ]
      .map(([k, l]) => `<button class="${PF.sens === k ? "on" : ""}" onclick="PF.sens='${k}';render()">${l}</button>`)
      .join("")}</div>
    <div class="search"><input class="in" placeholder="🔎 Conteneur ou plaque" value="${esc(PF.q)}" oninput="PF.q=this.value;clearTimeout(window._pq);window._pq=setTimeout(()=>renderKeep(),300)"></div>
    ${list.length ? list.slice(0, 150).map(ptCard).join("") : `<div class="empty">Aucun pointage.</div>`}`;
  return `<h1 class="page">Pointage</h1>${dayBar()}<div class="cols"><div class="sticky">${S.day === today() ? form : `<div class="banner">Le formulaire de pointage n'est disponible que sur la journée en cours.</div>`}</div><div>${lst}</div></div>`;
}
/**
 * Normalise la saisie du numéro de conteneur (majuscules, alphanumérique).
 * À 10 ou 11 caractères, redessine pour afficher le contrôle de clé ISO en
 * restaurant le focus et la position du curseur.
 */
function ptCn(el) {
  const p = el.selectionStart;
  el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  PT.cn = el.value;
  ptSave();
  if (el.value.length === 11 || el.value.length === 10) {
    render();
    const n = $("pt_cn");
    if (n) {
      n.focus();
      n.setSelectionRange(p, p);
    }
  }
}
/** Vignette de photo du formulaire (« Conteneur », « Scellé »…). */
function phTile(k, label) {
  const ref = PT.photos[k];
  return `<div class="ph" onclick="takePhoto('${k}')">${ref ? `<img data-ref="${esc(ref)}" alt=""><button class="x" onclick="event.stopPropagation();delete PT.photos['${k}'];ptSave();render()">✕</button>` : `<span class="ic">📷</span>${esc(label)}`}</div>`;
}
/**
 * Hook appelé par render() après chaque rendu : résout les <img data-ref>
 * (photo IndexedDB ou URL média + jeton de session).
 */
function afterRender() {
  document.querySelectorAll("img[data-ref]").forEach(async (im) => {
    const src = await photoSrc(im.getAttribute("data-ref"));
    if (src) im.src = src;
  });
}
/**
 * Ouvre l'appareil photo, compresse l'image et la garde en local.
 * @param {string} k emplacement de la photo : c1/s1/c2/s2
 */
function takePhoto(k) {
  const inp = $("camera");
  inp.value = "";
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const d = await compressPhoto(f);
      PT.photos[k] = await storeLocalPhoto(d);
      ptSave();
      render();
      toast("Photo ajoutée");
    } catch (e) {
      toast("Photo illisible", true);
    }
  };
  inp.click();
}
/**
 * Lecture d'un code-barres de conteneur par la caméra (BarcodeDetector).
 * Le flux est coupé à la fermeture de la feuille.
 */
async function scanTo(k) {
  try {
    const det = new BarcodeDetector();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    openSheet(
      `<h3>Scanner</h3><video id="scv" autoplay playsinline style="width:100%;border-radius:12px;background:#000"></video><button class="btn sec block" style="margin-top:10px" onclick="closeSheet()">Annuler</button>`,
      () => stream.getTracks().forEach((t) => t.stop())
    );
    const vid = $("scv");
    vid.srcObject = stream;
    const loop = async () => {
      if (!SHEET.open) return;
      try {
        const c = await det.detect(vid);
        if (c.length) {
          PT[k] = c[0].rawValue
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 11);
          ptSave();
          closeSheet();
          toast("Code lu");
          return;
        }
      } catch (e) {}
      requestAnimationFrame(loop);
    };
    vid.onloadedmetadata = loop;
  } catch (e) {
    toast("Caméra indisponible", true);
  }
}
/**
 * Valide et enregistre le pointage du formulaire, après contrôles :
 * numéro présent, longueur 11, clé ISO, second conteneur, présence des
 * scellés, et doublon (même conteneur, même sens, même site, même jour).
 * Chaque anomalie demande une confirmation explicite, jamais un blocage.
 */
function addPointage() {
  const cn = (PT.cn || "").toUpperCase().trim();
  if (!cn) {
    toast("N° de conteneur requis", true);
    return;
  }
  if (cn.length !== 11 && !confirm("Le numéro " + cn + " ne compte pas 11 caractères. Enregistrer quand même ?"))
    return;
  if (
    iso6346valid(cn) === false &&
    cn.length === 11 &&
    !confirm("La clé de contrôle ISO de " + cn + " ne correspond pas. Vérifie le numéro. Enregistrer quand même ?")
  )
    return;
  const vide = PT.etat === "Vide",
    two = PT.taille === "2x20'";
  if (two && !PT.cn2 && !confirm("2x20' sans second conteneur. Continuer ?")) return;
  if (!vide && !(PT.plomb || "").trim() && !confirm("Conteneur plein sans numéro de plomb. Enregistrer quand même ?"))
    return;
  if (
    !vide &&
    two &&
    PT.cn2 &&
    !(PT.plomb2 || "").trim() &&
    !confirm("2e conteneur plein sans numéro de plomb. Enregistrer quand même ?")
  )
    return;
  const prest = ptPrest(),
    site = ptSite();
  const dup = all("pointages").some(
    (p) => p.conteneur === cn && p.sens === PT.sens && p.site === site && dayOfISO(p.ts) === today()
  );
  if (dup && !confirm(cn + " a déjà été pointé en « " + PT.sens + " » aujourd'hui à ce site. Enregistrer quand même ?"))
    return;
  const ph = {};
  ["c1", "s1", "c2", "s2"].forEach((k) => {
    if (PT.photos[k] && (two || k[1] === "1") && (!vide || k[0] === "c")) ph[k] = PT.photos[k];
  });
  save("pointages", {
    id: uid(),
    ts: nowISO(),
    sens: PT.sens,
    etat: PT.etat,
    taille: PT.taille,
    conteneur: cn,
    conteneur2: two ? (PT.cn2 || "").toUpperCase() : "",
    plomb: vide ? "" : PT.plomb.trim(),
    plomb2: !vide && two ? PT.plomb2.trim() : "",
    plaque: (PT.plaque || "").toUpperCase().trim(),
    prestataire: prest,
    site,
    armateur: vide ? PT.arm : "",
    operateur: oper(),
    photos: ph,
    contreSigne: "",
    contrePar: ""
  });
  Object.assign(PT, { cn: "", cn2: "", plomb: "", plomb2: "", plaque: "", photos: {} });
  ptSave();
  S.day = today();
  render();
  toast("Pointage enregistré · " + cn);
  setTimeout(() => {
    const e = $("pt_cn");
    if (e) e.focus();
  }, 80);
}
/** true si le pointage a une contrepartie de sens inverse (arrivée ↔ départ). */
function ptMatched(p) {
  return all("pointages").some((o) => o.id !== p.id && o.conteneur === p.conteneur && o.sens !== p.sens);
}
/** Carte d'un pointage : identité, scellés, photos, contresignature, actions. */
function ptCard(p) {
  const r = role();
  const canSign = r === "site" && p.site === SITE_KEYS[ent()] && !p.contreSigne;
  const canDel =
    r === "ct" || ((r === "agent" || r === "pointeur") && p.operateur === oper() && dayOfISO(p.ts) === today());
  const nph = Object.keys(p.photos || {}).length;
  return `<div class="item"><div class="between"><span class="t mono">${esc(p.conteneur)}${p.conteneur2 ? " + " + esc(p.conteneur2) : ""}</span>
      <span><span class="pill ${p.sens === "Départ" ? "info" : "ok"}">${esc(p.sens)}</span> <span class="pill ${p.etat === "Plein" ? "warn" : "grey"}">${esc(p.etat)}</span></span></div>
    <div class="s">${esc(p.taille)} · ${p.plomb ? "plomb " + esc(p.plomb) + (p.plomb2 ? " + " + esc(p.plomb2) : "") + " · " : ""}${p.plaque ? `<span class="plate">${esc(p.plaque)}</span> · ` : ""}${esc(p.prestataire)} · ${esc(p.site)}${p.armateur ? " · " + esc(p.armateur) : ""}</div>
    <div class="s">${hm(p.ts)}${p.operateur ? " · " + esc(p.operateur) : ""} ${ptMatched(p) ? `<span class="pill ok">rapproché</span>` : ""} ${p.contreSigne ? `<span class="pill ok">contresigné ${hm(p.contreSigne)}</span>` : ""}</div>
    ${nph || canSign || canDel ? `<div class="acts">${nph ? `<button class="btn sec" onclick="showPhotos('${p.id}')">📷 Photos (${nph})</button>` : ""}${canSign ? `<button class="btn ok" onclick="contresigner('${p.id}')">✓ Contresigner</button>` : ""}${canDel ? `<button class="btn ghost" style="flex:0 0 auto;color:var(--err)" onclick="if(confirm('Supprimer ce pointage ?'))remove('pointages','${p.id}')">Supprimer</button>` : ""}</div>` : ""}</div>`;
}
/** Galerie des photos d'un pointage, dans une feuille modale. */
function showPhotos(id) {
  const p = get("pointages", id);
  if (!p) return;
  const L = { c1: "Conteneur", s1: "Scellé", c2: "2e conteneur", s2: "2e scellé" };
  openSheet(
    `<div class="between"><h3 class="mono">${esc(p.conteneur)}</h3><button class="btn ghost" onclick="closeSheet()">Fermer</button></div>` +
      Object.keys(p.photos || {})
        .map((k) => {
          const ref = p.photos[k];
          return `<label class="f">${L[k] || k}</label>${ref.indexOf("idb:") === 0 ? `<img data-ref="${esc(ref)}" style="width:100%;border-radius:10px;background:#eef2f6;min-height:80px" alt="Photo en attente d'envoi">` : `<img src="${esc(withPhotoToken(ref))}" style="width:100%;border-radius:10px" alt="">`}`;
        })
        .join("")
  );
  afterRender();
}
/** Contresigne un pointage par le chef de site connecté. */
function contresigner(id) {
  const p = get("pointages", id);
  if (!p) return;
  p.contreSigne = nowISO();
  p.contrePar = oper();
  save("pointages", p);
  toast("Contresigné");
}

/* =====================================================================
   RÉCEPTION (chef de site)
   Le chef de site contresigne les pointages faits sur son site.
   ===================================================================== */

/** Filtre de l'écran Réception : « att » (à contresigner) ou « jour ». */
const RC = { f: "att" };

/** Écran Réception : compteurs et liste des pointages du site. */
function viewReception() {
  const sk = SITE_KEYS[ent()];
  let l = all("pointages").filter((p) => p.site === sk);
  const att = l.filter((p) => !p.contreSigne);
  const dayL = l.filter((p) => dayOfISO(p.ts) === S.day);
  const list = (RC.f === "att" ? att : dayL).sort((a, b) => b.ts.localeCompare(a.ts));
  return `<h1 class="page">Réception · ${esc(sk)}</h1>
    <div class="kpis"><div class="kpi"><div class="n">${att.length}</div><div class="l">À contresigner</div></div><div class="kpi"><div class="n">${dayL.filter((p) => p.contreSigne).length}<small> / ${dayL.length}</small></div><div class="l">Contresignés du jour</div></div></div>
    <div class="chips"><button class="${RC.f === "att" ? "on" : ""}" onclick="RC.f='att';render()">À contresigner (${att.length})</button><button class="${RC.f === "jour" ? "on" : ""}" onclick="RC.f='jour';render()">Par journée</button></div>
    ${RC.f === "jour" ? dayBar() : ""}
    ${RC.f === "att" && att.length > 1 ? `<button class="btn ok block" style="margin-bottom:10px" onclick="signAll()">✓ Tout contresigner (${att.length})</button>` : ""}
    ${list.length ? `<div class="grid2">${list.slice(0, 200).map(ptCard).join("")}</div>` : `<div class="empty">Rien à afficher.</div>`}`;
}
/** Contresigne d'un coup tous les pointages en attente du site. */
function signAll() {
  const sk = SITE_KEYS[ent()];
  const l = all("pointages").filter((p) => p.site === sk && !p.contreSigne);
  if (!confirm("Contresigner les " + l.length + " pointages en attente ?")) return;
  const t = nowISO();
  l.forEach((p) => {
    p.contreSigne = t;
    p.contrePar = oper();
    save("pointages", p, true);
  });
  render();
  toast(l.length + " pointages contresignés");
}

/* =====================================================================
   POINTAGES (vue d'ensemble, donneur d'ordre)
   ===================================================================== */

/** Filtres de la vue CT : prestataire, site, sens. */
const PC = { pr: "", site: "", sens: "" };

/** Écran Pointages CT : filtres, total TEU et liste détaillée. */
function viewPointagesCT() {
  let l = all("pointages").filter((p) => dayOfISO(p.ts) === S.day);
  const tot = l.length;
  if (PC.pr) l = l.filter((p) => p.prestataire === PC.pr);
  if (PC.site) l = l.filter((p) => p.site === PC.site);
  if (PC.sens) l = l.filter((p) => p.sens === PC.sens);
  l.sort((a, b) => b.ts.localeCompare(a.ts));
  const teu = l.reduce((s, p) => s + teuT(p.taille), 0);
  return `<h1 class="page">Pointages</h1>${dayBar()}
    <div class="row" style="margin-bottom:10px;flex-wrap:wrap"><select class="in" onchange="PC.pr=this.value;render()"><option value="">Tous prestataires</option>${opts(PRESTATAIRES, PC.pr)}</select>
      <select class="in" onchange="PC.site=this.value;render()"><option value="">Tous sites</option>${opts(SITES, PC.site)}</select>
      <select class="in" onchange="PC.sens=this.value;render()"><option value="">Arrivées et départs</option>${opts(["Arrivée", "Départ"], PC.sens)}</select></div>
    <div class="small muted" style="margin:0 2px 10px">${l.length} pointage(s) sur ${tot} · ${teu} TEU · ${l.filter((p) => !ptMatched(p)).length} non rapproché(s)</div>
    ${l.length ? `<div class="grid2">${l.slice(0, 300).map(ptCard).join("")}</div>` : `<div class="empty">Aucun pointage.</div>`}`;
}
