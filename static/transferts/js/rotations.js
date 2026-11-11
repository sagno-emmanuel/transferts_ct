/* =====================================================================
   Transferts CT — ROTATIONS ET INCIDENTS
   =====================================================================
   Chargé après core.js et shell.js. Un « voyage » (type `voyages`) représente
   une rotation de camion : une plaque, une opération, une date et 12 jalons
   horodatés. Ce module fournit :
     - la liste des rotations, filtrée selon le rôle et la journée ;
     - l'action « prochaine étape » propre à chaque intervenant ;
     - la feuille de détail (jalons, taille du plein, sortie, incidents) ;
     - l'onglet Incidents, qui agrège les pannes de toutes les rotations.
   ===================================================================== */

/** Filtres de la liste : onglet actif, recherche plaque, prestataire sélectionné. */
const RF = { filter: "todo", q: "", pr: "" };

/** Rotations du jour visibles pour la session courante. */
function rotationsVisible() {
  let l = all("voyages").filter((v) => v.date === S.day);
  if (role() === "presta") l = l.filter((v) => v.prestataire === ent());
  return l;
}
/**
 * Écran Rotations : compteurs par onglet, recherche, filtres et cartes.
 * L'onglet « À traiter » n'apparaît que si le rôle a des jalons à valider.
 */
function viewRotations() {
  const r = role();
  const mine = ownedJalons();
  const canCreate = r === "presta" || (r === "agent" && agentSite() === "CT") || r === "ct";
  let list = rotationsVisible();
  const cnt = { todo: 0, cours: 0, fini: 0, all: list.length };
  list.forEach((v) => {
    const st = vyStatus(v);
    if (st === "fini" || st === "nonsorti") cnt.fini++;
    else cnt.cours++;
    if (st !== "nonsorti" && myTurn(v)) cnt.todo++;
  });
  if (!mine.length && RF.filter === "todo") RF.filter = "all";
  if (RF.pr) list = list.filter((v) => v.prestataire === RF.pr);
  if (RF.q) {
    const q = RF.q.toUpperCase().replace(/[\s-]/g, "");
    list = list.filter((v) => (v.plaque || "").toUpperCase().replace(/[\s-]/g, "").includes(q));
  }
  list = list.filter((v) => {
    const st = vyStatus(v);
    if (RF.filter === "todo") return myTurn(v) && st !== "nonsorti";
    if (RF.filter === "cours") return st === "attente" || st === "cours";
    if (RF.filter === "fini") return st === "fini" || st === "nonsorti";
    return true;
  });
  list.sort((a, b) => (b._v || 0) - (a._v || 0));
  const chips = [
    mine.length ? ["todo", "À traiter (" + cnt.todo + ")"] : null,
    ["cours", "En cours (" + cnt.cours + ")"],
    ["fini", "Terminées (" + cnt.fini + ")"],
    ["all", "Toutes (" + cnt.all + ")"]
  ].filter(Boolean);
  return `<h1 class="page">Rotations</h1>${dayBar()}
    <div class="chips">${chips.map(([k, l]) => `<button class="${RF.filter === k ? "on" : ""}" onclick="RF.filter='${k}';render()">${l}</button>`).join("")}</div>
    <div class="search"><input class="in" placeholder="🔎 Rechercher une plaque" value="${esc(RF.q)}" oninput="RF.q=this.value;clearTimeout(window._rq);window._rq=setTimeout(()=>{render();const i=document.querySelector('.search input');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}},250)">
      ${r !== "presta" ? `<select class="in" style="max-width:150px" onchange="RF.pr=this.value;render()"><option value="">Tous</option>${opts(PRESTATAIRES, RF.pr)}</select>` : ""}</div>
    ${list.length ? `<div class="grid2">${list.map(rotCard).join("")}</div>` : `<div class="empty">${RF.filter === "todo" ? "Rien à traiter pour toi sur cette journée." : "Aucune rotation."}</div>`}
    ${canCreate && S.day === today() ? `<button class="fab" onclick="newRotationSheet()">＋ Nouvelle rotation</button>` : ""}`;
}
// Parcours attendu selon le trajet indiqué dans le nom de l'opération (sert à proposer la bonne étape ;
// tous les jalons restent saisissables dans le détail de la rotation).
/**
 * Parcours théorique d'une rotation, déduit du libellé de l'opération.
 * Sert à proposer la bonne étape suivante et à dessiner la frise ; tous les
 * jalons restent modifiables dans le détail.
 * @returns {string[]} jalons attendus, dans l'ordre
 */
function route(v) {
  const op = v.operation || "";
  if (/Boucle Simple/i.test(op))
    return ["Chargement du vide", "Sortie de Kagbélen", "Arrivée à CT", "Déchargement du vide à CT"];
  if (/Intramuros BU|KIDAL|pleins Burkina/i.test(op)) return ["Arrivée à CT", "Déchargement du vide à CT"];
  if (/Roro/i.test(op)) return JALONS.slice(0, 8);
  if (/PSK\s*→\s*PSK/i.test(op)) return ["Chargement du vide", "Déchargement PSK"];
  return JALONS;
}
// Étape proposée à l'utilisateur : sa prochaine étape sur le parcours, si les étapes précédentes sont faites
// (une seule étape oubliée par un autre intervenant est tolérée).
/**
 * Prochaine étape que l'utilisateur courant peut valider sur cette rotation.
 * Règles : l'étape doit lui appartenir et suivre la dernière étape validée
 * (une seule étape oubliée par un autre intervenant est tolérée), et un
 * agent PSK ne peut rien valider avant la sortie du terminal.
 * @returns {string|null} nom du jalon, ou null s'il n'y a rien à faire
 */
function myNext(v) {
  const mine = ownedJalons();
  if (!mine.length) return null;
  const R = route(v);
  const J = v.jalons || {};
  const nm = R.find((j) => mine.indexOf(j) >= 0 && !J[j]);
  if (!nm) return null;
  const idx = R.indexOf(nm);
  let last = -1;
  R.forEach((j, i) => {
    if (J[j]) last = i;
  });
  if (last > idx) return null;
  if (R.slice(last + 1, idx).length > 1) return null;
  if (JALON_OWNER[nm] === "PSK" && R.indexOf(JALON_SORTIE) >= 0 && !J[JALON_SORTIE]) return null;
  return nm;
}
/** true si c'est au tour de l'utilisateur courant d'agir sur cette rotation. */
function myTurn(v) {
  return !!myNext(v);
}

/** Carte de rotation dans la liste (statut, facturation, frise et action rapide). */
function rotCard(v) {
  const nm = myNext(v);
  const st = vyStatus(v);
  const F = vyFactu(v);
  const nInc = (v.incidents || []).length;
  const R = route(v);
  const nx = nextJalon(v, R);
  const pills = [
    st === "fini"
      ? `<span class="pill ok">Terminée</span>`
      : st === "nonsorti"
        ? `<span class="pill err">${esc(v.sorti)}</span>`
        : st === "attente"
          ? `<span class="pill grey">En attente</span>`
          : `<span class="pill info">En cours</span>`,
    F.facturable ? `<span class="pill ok">${esc(F.type)}</span>` : "",
    vyCompteObj(v) ? `<span class="pill info">${teuT(v.taille)} TEU</span>` : "",
    nInc ? `<span class="pill err">${nInc} panne(s)</span>` : ""
  ].join(" ");
  return `<div class="item"><div class="between"><span class="plate">${esc(v.plaque || "—")}</span><span class="small muted">${esc(v.prestataire)} · ${esc(v.taille || "")}</span></div>
    <div class="s">${esc(opShort(v.operation))}${nx ? ` · prochaine étape : <b>${esc(nx)}</b>` : ""}</div>
    <div class="steps">${R.map((j) => `<i class="${(v.jalons || {})[j] ? "d" : j === nx ? "n" : ""}" title="${esc(j)}"></i>`).join("")}</div>
    <div style="margin-top:8px">${pills}</div>
    <div class="acts">${nm && st !== "nonsorti" ? `<button class="btn ok" onclick="stampNext('${v.id}')">▶ ${esc(nm)}</button>` : ""}<button class="btn sec" style="flex:0 0 auto" onclick="openRotation('${v.id}')">Détails</button></div></div>`;
}
/** Valide en un clic la prochaine étape de l'utilisateur, horodatée à maintenant. */
function stampNext(id) {
  const v = get("voyages", id);
  if (!v) return;
  const nm = myNext(v);
  if (!nm) return;
  v.jalons = v.jalons || {};
  v.jalons[nm] = nowISO();
  if (nm === JALON_SORTIE && !v.sorti) v.sorti = "Sorti";
  save("voyages", v);
  toast(nm + " · " + hm(v.jalons[nm]));
}
/** Feuille de création d'une rotation (prestataire, opération, plaque, taille). */
function newRotationSheet() {
  const r = role();
  const pr = r === "presta" ? ent() : S.ui.lastPr || PRESTATAIRES[0];
  openSheet(`<h3>Nouvelle rotation</h3>
    ${r !== "presta" ? `<label class="f">Prestataire</label><select class="in" id="nr_pr" onchange="document.getElementById('nr_pl_list').innerHTML=plateOptions(this.value)">${opts(PRESTATAIRES, pr)}</select>` : ""}
    <label class="f">Opération</label><select class="in" id="nr_op">${opts(OPERATIONS, S.ui.lastOp || OPERATIONS[0])}</select>
    <label class="f">Plaque du camion</label><input class="in big" id="nr_pl" list="nr_pl_list" placeholder="Choisir ou saisir" autocomplete="off"><datalist id="nr_pl_list">${plateOptions(pr)}</datalist>
    <label class="f">Taille du plein</label><div class="seg" id="nr_t">${["2x20'", "40'"].map((t, i) => `<button class="${i === 0 ? "on" : ""}" onclick="segOn(this)">${t}</button>`).join("")}</div>
    <div class="btns" style="margin-top:16px"><button class="btn sec" onclick="createRotation(true)">Créer et en ajouter une autre</button><button class="btn" onclick="createRotation(false)">Créer</button></div>`);
}
/** Options de la liste de plaques (datalist) pour un prestataire. */
function plateOptions(pr) {
  return (FLEET[pr] || []).map((p) => `<option value="${esc(p)}">`).join("");
}
/** Active un bouton dans un groupe « seg » (boutons mutuellement exclusifs). */
function segOn(btn) {
  [...btn.parentNode.children].forEach((b) => b.classList.toggle("on", b === btn));
}
/** Valeur sélectionnée dans un groupe « seg » identifié par son id. */
function segVal(id) {
  const b = document.querySelector("#" + id + " button.on");
  return b ? b.textContent : "";
}
/**
 * Crée la rotation saisie dans la feuille. Avertit si le camion a déjà une
 * rotation en cours aujourd'hui.
 * @param {boolean} again true = garder la feuille ouverte pour en créer une autre
 */
function createRotation(again) {
  const r = role();
  const pr = r === "presta" ? ent() : $("nr_pr").value;
  const pl = ($("nr_pl").value || "").toUpperCase().trim();
  if (!pl) {
    toast("Indique la plaque", true);
    return;
  }
  const dup = all("voyages").find(
    (v) => v.date === today() && v.plaque === pl && !rotOK(v) && vyStatus(v) !== "nonsorti"
  );
  if (dup && !confirm("Ce camion a déjà une rotation en cours aujourd'hui. En créer une autre ?")) return;
  const op = $("nr_op").value;
  S.ui.lastPr = pr;
  S.ui.lastOp = op;
  LS.set("ui", S.ui);
  save("voyages", {
    id: uid(),
    date: today(),
    prestataire: pr,
    operation: op,
    plaque: pl,
    taille: segVal("nr_t") || "2x20'",
    jalons: {},
    incidents: [],
    sorti: "",
    operateur: oper(),
    cree: nowISO()
  });
  toast("Rotation créée · " + pl);
  if (again) {
    $("nr_pl").value = "";
    $("nr_pl").focus();
  } else closeSheet();
}
/** Ouvre le détail d'une rotation, en le rafraîchissant à chaque modification. */
function openRotation(id) {
  const draw = () => {
    const v = get("voyages", id);
    if (!v) {
      closeSheet();
      return;
    }
    sheetHTML(rotationHTML(v));
  };
  openSheet(rotationHTML(get("voyages", id)), null, draw);
}
/**
 * Contenu HTML du détail d'une rotation : facturation, taille, sortie,
 * les 12 jalons (saisissables selon le périmètre) et les incidents.
 */
function rotationHTML(v) {
  const r = role();
  const mine = ownedJalons();
  const R = route(v);
  const nx = nextJalon(v, R);
  const F = vyFactu(v);
  const canTaille = r === "presta" || (r === "agent" && agentSite() === "CT") || r === "ct";
  const canSortie = mine.indexOf(JALON_SORTIE) >= 0 || r === "ct";
  const canInc = r === "agent" || r === "presta" || r === "hse" || r === "ct";
  const canDel = r === "ct" || (r === "agent" && agentSite() === "CT") || (r === "presta" && vyDone(v) === 0);
  let h = `<div class="between"><h3><span class="plate">${esc(v.plaque || "—")}</span></h3><button class="btn ghost" onclick="closeSheet()">Fermer</button></div>
    <div class="small muted">${esc(v.prestataire)} · ${esc(opShort(v.operation))} · ${esc(v.date)}${v.operateur ? " · créée par " + esc(v.operateur) : ""}</div>
    <div style="margin:8px 0">${F.facturable ? `<span class="pill ok">Facturable : ${esc(F.type)}</span>` : `<span class="pill grey">Pas encore facturable</span>`} ${opSortiePlein(v.operation) ? (vyCompteObj(v) ? `<span class="pill info">Compte objectif · ${teuT(v.taille)} TEU</span>` : `<span class="pill warn">Plein pas encore sorti</span>`) : ""}</div>
    <div class="row"><div><label class="f">Taille du plein</label><select class="in" ${canTaille ? `onchange="setVy('${v.id}','taille',this.value)"` : "disabled"}>${opts(["2x20'", "40'"], v.taille)}</select></div>
    ${canSortie ? `<div><label class="f">Sortie du terminal</label><select class="in" onchange="setVy('${v.id}','sorti',this.value)"><option value="">—</option>${opts(RAISONS_NONSORTIE, v.sorti)}</select></div>` : ""}</div>
    <h2 class="sec">Étapes</h2>`;
  JALONS.forEach((j, i) => {
    const ts = (v.jalons || {})[j];
    const ed = mine.indexOf(j) >= 0 || r === "ct";
    h += `<div class="jal ${ts ? "done" : j === nx ? "next" : ""}"><div class="num">${ts ? "✓" : i + 1}</div><div class="jn">${esc(j)}<small>${OWNER_LABEL[JALON_OWNER[j]]}${R.indexOf(j) < 0 ? " · hors parcours habituel" : ""}${ed ? "" : " · lecture seule"}</small></div>
      ${ed ? `<input type="time" value="${ts ? new Date(ts).toTimeString().slice(0, 5) : ""}" onchange="setJal('${v.id}',${i},this.value)">${ts ? "" : `<button class="btn accent sm" onclick="setJalNow('${v.id}',${i})">Top</button>`}` : `<span class="tm">${ts ? hm(ts) : "—"}</span>`}</div>`;
  });
  h += `<h2 class="sec">Pannes et incidents (${(v.incidents || []).length})</h2>`;
  h +=
    (v.incidents || [])
      .map(
        (
          x,
          i
        ) => `<div class="kv"><span>${esc(x.type)} · ${hm(x.tsIncident || x.ts)}${x.tsInterv ? " → " + hm(x.tsInterv) + " (" + mins(x.tsIncident, x.tsInterv) + " min)" : ""}${x.desc ? "<br><span class='small muted'>" + esc(x.desc) + "</span>" : ""}</span>
    ${canInc && !x.tsInterv ? `<button class="btn soft sm" onclick="closeInc('${v.id}',${i})">Reprise</button>` : ""}</div>`
      )
      .join("") || `<div class="small muted">Aucune.</div>`;
  if (canInc)
    h += `<button class="btn err block" style="margin-top:10px" onclick="incidentSheet('${v.id}')">🚨 Déclarer une panne / un incident</button>`;
  if (canDel)
    h += `<button class="btn ghost block" style="margin-top:8px;color:var(--err)" onclick="if(confirm('Supprimer cette rotation ?')){remove('voyages','${v.id}');closeSheet();toast('Rotation supprimée');}">Supprimer la rotation</button>`;
  return h;
}
/** Modifie un champ simple d'une rotation (taille du plein, sortie du terminal). */
function setVy(id, f, val) {
  const v = get("voyages", id);
  if (!v) return;
  v[f] = val;
  save("voyages", v);
}
/**
 * Enregistre l'heure d'un jalon saisie manuellement.
 * Vider le champ supprime le jalon ; l'heure est recalée au lendemain si
 * elle précède de plus d'une heure le jalon précédent (poste de nuit).
 */
function setJal(id, i, val) {
  const j = JALONS[i];
  const v = get("voyages", id);
  if (!v) return;
  v.jalons = v.jalons || {};
  if (!val) delete v.jalons[j];
  else {
    const prev = JALONS.slice(0, i)
      .map((x) => v.jalons[x])
      .filter(Boolean)
      .sort()
      .pop();
    v.jalons[j] = isoAfter(v.date, val, prev);
  }
  if (j === JALON_SORTIE && val && !v.sorti) v.sorti = "Sorti";
  save("voyages", v);
}
/** Valide un jalon à l'heure courante (bouton « Top »). */
function setJalNow(id, i) {
  const j = JALONS[i];
  const v = get("voyages", id);
  if (!v) return;
  v.jalons = v.jalons || {};
  v.jalons[j] = nowISO();
  if (j === JALON_SORTIE && !v.sorti) v.sorti = "Sorti";
  save("voyages", v);
  toast(j + " · " + hm(v.jalons[j]));
}
/**
 * Feuille de déclaration d'un incident.
 * @param {string} [vid] rotation imposée ; sinon l'utilisateur choisit parmi
 *                       les rotations du jour.
 */
function incidentSheet(vid) {
  const nowHM = new Date().toTimeString().slice(0, 5);
  const r = role();
  const rots = vid
    ? [get("voyages", vid)]
    : all("voyages")
        .filter((v) => v.date === S.day && (r !== "presta" || v.prestataire === ent()))
        .sort((a, b) => (a.plaque || "").localeCompare(b.plaque || ""));
  if (!rots.length) {
    toast("Aucune rotation ce jour pour y rattacher un incident", true);
    return;
  }
  openSheet(`<h3>Déclarer une panne / un incident</h3>
    <label class="f">Camion (rotation)</label><select class="in" id="in_v">${rots.map((v) => `<option value="${v.id}">${esc(v.plaque || "—")} · ${esc(v.prestataire)} · ${esc(opShort(v.operation))}</option>`).join("")}</select>
    <label class="f">Type</label><div class="chips" id="in_t" style="flex-wrap:wrap">${INCIDENT_TYPES.map((t, i) => `<button class="${i === 0 ? "on" : ""}" onclick="segOn(this)">${esc(t)}</button>`).join("")}</div>
    <div class="row"><div><label class="f">Heure</label><input class="in" type="time" id="in_h1" value="${nowHM}"></div><div><label class="f">Reprise (si connue)</label><input class="in" type="time" id="in_h2"></div></div>
    <label class="f">Lieu / description</label><textarea class="in" id="in_d" placeholder="Optionnel"></textarea>
    <button class="btn err block" style="margin-top:14px" onclick="addIncident()">Déclarer</button>`);
}
/** Enregistre l'incident saisi (type, heure de début, reprise éventuelle, description). */
function addIncident() {
  const v = get("voyages", $("in_v").value);
  if (!v) return;
  v.incidents = v.incidents || [];
  // heure saisie : jour de la rotation, ou le lendemain si elle précède la création (poste de nuit)
  const t1 = isoAfter(v.date, $("in_h1").value, v.cree) || nowISO();
  const t2 = $("in_h2").value ? isoAfter(v.date, $("in_h2").value, t1) : "";
  v.incidents.push({
    ts: nowISO(),
    type: segVal("in_t"),
    tsIncident: t1,
    tsInterv: t2,
    desc: $("in_d").value.trim(),
    operateur: oper()
  });
  save("voyages", v);
  closeSheet();
  toast("Incident déclaré");
}
/** Enregistre la reprise (fin d'incident) à l'heure courante. */
function closeInc(vid, i) {
  const v = get("voyages", vid);
  if (!v || !v.incidents[i]) return;
  v.incidents[i].tsInterv = nowISO();
  save("voyages", v);
  toast("Reprise enregistrée");
}

/* =====================================================================
   ONGLET INCIDENTS
   Vue transverse : toutes les pannes du jour, tous prestataires confondus.
   ===================================================================== */

/** Écran Incidents : compteurs (déclarés / sans reprise) et liste détaillée. */
function viewIncidents() {
  const r = role();
  const l = [];
  all("voyages")
    .filter((v) => v.date === S.day)
    .forEach((v) => (v.incidents || []).forEach((x, i) => l.push({ v, x, i })));
  l.sort((a, b) => (b.x.tsIncident || b.x.ts || "").localeCompare(a.x.tsIncident || a.x.ts || ""));
  const open = l.filter((o) => !o.x.tsInterv).length;
  return `<h1 class="page">Incidents</h1>${dayBar()}
    <div class="kpis"><div class="kpi"><div class="n">${l.length}</div><div class="l">Déclarés</div></div><div class="kpi"><div class="n">${open}</div><div class="l">Sans reprise</div></div></div>
    ${
      l.length
        ? l
            .map(
              ({
                v,
                x,
                i
              }) => `<div class="item"><div class="between"><span class="t">${esc(x.type)}</span>${x.tsInterv ? `<span class="pill ok">Repris · ${mins(x.tsIncident, x.tsInterv)} min</span>` : `<span class="pill err">En cours</span>`}</div>
      <div class="s"><span class="plate">${esc(v.plaque || "—")}</span> ${esc(v.prestataire)} · ${esc(opShort(v.operation))} · ${hm(x.tsIncident || x.ts)}${x.operateur ? " · " + esc(x.operateur) : ""}</div>
      ${x.desc ? `<div class="s">${esc(x.desc)}</div>` : ""}
      <div class="acts">${!x.tsInterv ? `<button class="btn soft" onclick="closeInc('${v.id}',${i})">Reprise maintenant</button>` : ""}<button class="btn sec" onclick="openRotation('${v.id}')">Voir la rotation</button></div></div>`
            )
            .join("")
        : `<div class="empty">Aucun incident déclaré.</div>`
    }
    <button class="fab" style="background:var(--err)" onclick="incidentSheet()">🚨 Déclarer</button>`;
}
