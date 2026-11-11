# Transferts CT — Django avec base locale

L'application utilise désormais la base SQLite incluse par défaut dans
Django. Elle ne contacte pas Supabase. Les contrôles et règles des fonctions
SQL historiques (`tct_connect`, `tct_session_set`, `tct_pull`, `tct_push`,
`tct_set_access_code`, `tct_logout`) sont portés dans `transferts/services.py`; les
anciens fichiers SQL restent inchangés dans `sql/` comme référence. Ils ne
doivent plus être exécutés pour cette version.

## Installation Windows

Extraire l'archive dans un sous-dossier (par exemple
`E:\Mes Projets\Django\transferts_ct_django`), puis ouvrir PowerShell dans ce
dossier :

```powershell
py -3.12 -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python manage.py migrate
python manage.py setup_access_codes
```

La commande `setup_access_codes` demande de choisir et confirmer un code de 4 à
8 chiffres pour chaque accès initial. Elle stocke uniquement des empreintes
bcrypt; les codes ne sont pas écrits dans les fichiers. Les codes doivent être
uniques, comme dans le SQL d'origine. Les prestataires initiaux sont AGL, EDT,
GOS, GSL, COPRELOG, IKT et NLS. Les codes d'autres prestataires se gèrent
ensuite depuis Réglages.

Ouvrir `.env` et remplacer `DJANGO_SECRET_KEY` par une valeur aléatoire. Puis :

```powershell
python manage.py runserver
```

Ouvrir http://127.0.0.1:8000. Pour partager l'application entre plusieurs
appareils, héberger Django et le fichier `db.sqlite3` sur un serveur commun du
réseau; une base SQLite locale distincte sur chaque appareil ne se synchronise
pas avec les autres. Utiliser un serveur WSGI/ASGI pour un déploiement réel,
avec `DJANGO_DEBUG=false`, une vraie clé Django et les hôtes autorisés.

## Reprise des données existantes

L'archive source ne contient pas les enregistrements actuels de la base Supabase.
Avant de basculer, produire une sauvegarde JSON depuis l'application existante
(Réglages → Export des données), puis l'importer après `migrate` :

```powershell
python manage.py import_backup "C:\chemin\sauvegarde_transferts_ct_2026-11-10.json"
```

La commande importe les enregistrements actifs, réglages et référentiels du
fichier généré par l'application. Elle ne remplace pas les codes d'accès; ceux-ci
sont définis avec `setup_access_codes`. L'option `--replace` efface les lignes
métier locales avant import, à utiliser seulement pour un import complet dans
une base neuve.

Les anciennes photos conservent leurs URL dans les enregistrements importés et
restent accessibles tant que leur ancien stockage l'est. Les nouvelles photos
sont stockées localement sous `media/tct-photos/`.

## Données et règles conservées

- Les tables Django `TctCode`, `TctSession`, `TctRecord` et `TctLoginFail`
  représentent les codes, sessions, enregistrements JSON et essais de connexion
  de la base historique.
- La connexion conserve le bcrypt, le frein d'une seconde après un code erroné,
  la limite de 30 essais par fenêtre de 10 minutes et les sessions de 30 jours.
- Les autorisations par rôle, périmètre, types de données, sélection de site,
  visibilité des réglages/référentiels et refus de création pour prestataire/site
  suivent les conditions des fonctions SQL d'origine.
- La synchronisation garde les mêmes payloads RPC, séquences de changement et
  file locale; l'API Django implémente ces opérations sur SQLite.
- Les photos gardent la limite historique d'1 Mo et le format JPEG. Les exports
  Excel utilisent encore SheetJS depuis cdnjs.cloudflare.com.

## Tests

Les tests sont dans `transferts/tests.py`. Après installation :

```powershell
python manage.py check
python manage.py test
```

Vérification effectuée avec Python 3.12.9 et Django 5.2.19 : `manage.py check`
ne signale aucun problème et les 8 tests passent.

## Correspondance des fichiers

| Source d'origine | Projet Django | Contenu |
|---|---|---|
| `src/head.html.txt` | `templates/transferts/index.html` | HTML et CSS |
| `src/core.js.txt` | `static/transferts/js/core.js` | référentiels, règles de rotation/facturation/TEU, persistance locale et synchronisation |
| `src/shell.js.txt` | `static/transferts/js/shell.js` | navigation, connexion et sessions |
| `src/rotations.js.txt` | `static/transferts/js/rotations.js` | rotations, jalons, parcours et incidents |
| `src/pointage.js.txt` | `static/transferts/js/pointage.js` | pointages et contresignature |
| `src/ordres.js.txt` | `static/transferts/js/ordres.js` | ordres, programmes et flotte |
| `src/suivi.js.txt` | `static/transferts/js/suivi.js` | convois, tableau de bord, réglages et exports |
| Fonctions de `sql/01_installation.sql`, `02_connexion.sql`, `03_referentiels.sql` | `transferts/services.py` | logique métier et contrôle d'accès portés en Python |
| Schéma des tables SQL | `transferts/models.py` et `transferts/migrations/` | modèle et schéma SQLite |
| Données initiales SQL | `transferts/fixtures/initial_records.json` | objectif et référentiel initial, extraits des SQL source |
| `build.py.txt`, guide et contexte Copilot | `docs/source_archive/` | documentation originale archivée |

Les sources et documents d'origine sont conservés dans `docs/source_archive/`. Le
fichier généré `dist/index.html.txt` n'est pas utilisé : le projet sert les
modules séparément et ne reprend pas la clé publique intégrée à cette ancienne
page compilée.
