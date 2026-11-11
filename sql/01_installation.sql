-- =====================================================================
-- Transferts CT — version 4.1 : installation de la base (1/2)
-- Supabase > SQL Editor > New query > coller l'ensemble > Run
-- Le script peut être relancé sans risque : il ne recrée que ce qui manque.
-- =====================================================================
-- Principe de sécurité : la clé publique (anon) n'a plus aucun accès direct
-- aux tables. Tout passe par des fonctions qui vérifient une session ouverte
-- avec un code d'accès. Les codes sont stockés chiffrés (bcrypt).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------
create table if not exists public.tct_codes (
  role      text not null,            -- ct, agent, hse, site, presta
  entity    text not null default '', -- société pour presta (AGL, EDT...), vide sinon
  code_hash text not null,
  primary key (role, entity)
);

create table if not exists public.tct_sessions (
  token      uuid primary key default gen_random_uuid(),
  role       text not null,
  entity     text,
  site       text,
  operateur  text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

create sequence if not exists public.tct_seq;

create table if not exists public.tct_records (
  id         text primary key,
  type       text not null,
  entity     text,                     -- prestataire concerné
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  seq        bigint not null default nextval('public.tct_seq'),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists tct_records_seq_idx on public.tct_records (seq);
create index if not exists tct_records_entity_seq_idx on public.tct_records (entity, seq);

-- Aucun accès direct depuis l'application
alter table public.tct_codes    enable row level security;
alter table public.tct_sessions enable row level security;
alter table public.tct_records  enable row level security;
revoke all on public.tct_codes, public.tct_sessions, public.tct_records from anon, authenticated;
revoke all on sequence public.tct_seq from anon, authenticated;

-- ---------- Codes d'accès initiaux ----------
-- AVANT EXÉCUTION : remplacer chaque CODE_xxx par un code numérique de 6 chiffres,
-- tous différents (chaque code ouvre directement le module correspondant).
-- Ils peuvent ensuite être changés depuis l'application : Réglages > Codes d'accès.
insert into public.tct_codes (role, entity, code_hash) values
  ('ct',     '',         extensions.crypt('CODE_CT', extensions.gen_salt('bf'))),
  ('agent',  '',         extensions.crypt('CODE_AGENT', extensions.gen_salt('bf'))),
  ('hse',    '',         extensions.crypt('CODE_HSE', extensions.gen_salt('bf'))),
  ('site',   '',         extensions.crypt('CODE_SITE', extensions.gen_salt('bf'))),
  ('presta', 'AGL',      extensions.crypt('CODE_AGL', extensions.gen_salt('bf'))),
  ('presta', 'EDT',      extensions.crypt('CODE_EDT', extensions.gen_salt('bf'))),
  ('presta', 'GOS',      extensions.crypt('CODE_GOS', extensions.gen_salt('bf'))),
  ('presta', 'GSL',      extensions.crypt('CODE_GSL', extensions.gen_salt('bf'))),
  ('presta', 'COPRELOG', extensions.crypt('CODE_COPRELOG', extensions.gen_salt('bf'))),
  ('presta', 'IKT',      extensions.crypt('CODE_IKT', extensions.gen_salt('bf'))),
  ('presta', 'NLS',      extensions.crypt('CODE_NLS', extensions.gen_salt('bf')))
on conflict (role, entity) do nothing;


-- ---------- Réglages initiaux (contacts et objectif), visibles du seul donneur d'ordre ----------
insert into public.tct_records (id, type, entity, data, updated_by) values ('__settings__', 'settings', null, $json${
  "objTeu": 250,
  "contacts": {"prestataires": {}, "sites": {}, "ct": {"equipe": []}}
}$json$::jsonb, 'installation')
on conflict (id) do nothing;

-- ---------- Fonctions ----------
-- Session courante (erreur si absente ou expirée)
create or replace function public.tct_get_session(p_token uuid)
returns public.tct_sessions
language plpgsql security definer set search_path = public, extensions as $$
declare s public.tct_sessions;
begin
  select * into s from public.tct_sessions where token = p_token and expires_at > now();
  if not found then raise exception 'session_expiree'; end if;
  return s;
end $$;

-- Connexion : rôle + société/site + code -> jeton de session
create or replace function public.tct_login(p_role text, p_entity text, p_site text, p_code text, p_operateur text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare h text; k_role text; k_entity text; tok uuid;
begin
  if p_role not in ('ct','agent','hse','site','presta','pointeur') then raise exception 'role_inconnu'; end if;
  if coalesce(trim(p_operateur),'') = '' then raise exception 'nom_requis'; end if;
  -- Prestataire et agent terrain prestataire partagent le code de leur société
  k_role   := case when p_role in ('presta','pointeur') then 'presta' else p_role end;
  k_entity := case when p_role in ('presta','pointeur') then coalesce(p_entity,'') else '' end;
  select code_hash into h from public.tct_codes where role = k_role and entity = k_entity;
  if h is null or extensions.crypt(coalesce(p_code,''), h) <> h then
    perform pg_sleep(1);  -- freine les essais en série
    raise exception 'code_incorrect';
  end if;
  delete from public.tct_sessions where expires_at < now();
  insert into public.tct_sessions (role, entity, site, operateur)
  values (p_role, nullif(p_entity,''), nullif(p_site,''), left(trim(p_operateur), 60))
  returning token into tok;
  return json_build_object('token', tok, 'role', p_role, 'entity', nullif(p_entity,''), 'site', nullif(p_site,''), 'operateur', trim(p_operateur));
end $$;

create or replace function public.tct_logout(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.tct_sessions where token = p_token;
$$;

-- Lecture des changements depuis le dernier numéro reçu, filtrés selon le rôle
create or replace function public.tct_pull(p_token uuid, p_since bigint, p_limit int default 300)
returns setof public.tct_records
language plpgsql security definer set search_path = public, extensions as $$
declare s public.tct_sessions;
begin
  s := public.tct_get_session(p_token);
  return query
    select r.* from public.tct_records r
    where r.seq > coalesce(p_since, 0)
      and (r.type <> 'settings' or s.role = 'ct')
      and (
        s.role in ('ct','agent','hse')
        or (s.role = 'site' and r.type in ('programmes','pointages'))
        or (s.role = 'presta' and r.entity = s.entity and r.type in ('programmes','flotte','retraits','voyages','pointages'))
        or (s.role = 'pointeur' and r.entity = s.entity and r.type = 'pointages')
      )
    order by r.seq
    limit least(greatest(coalesce(p_limit, 300), 1), 500);
end $$;

-- Écriture d'un lot de modifications, avec contrôle des droits par rôle
create or replace function public.tct_push(p_token uuid, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.tct_sessions; e jsonb; t text; rid text; ent text; cur public.tct_records;
  allowed text[]; ok_ids text[] := '{}'; ko_ids text[] := '{}'; who text;
begin
  s := public.tct_get_session(p_token);
  allowed := case s.role
    when 'ct'       then array['programmes','flotte','retraits','voyages','pointages','convois','settings']
    when 'agent'    then array['voyages','pointages','convois']
    when 'hse'      then array['convois','voyages']
    when 'site'     then array['pointages']
    when 'presta'   then array['programmes','flotte','retraits','voyages']
    when 'pointeur' then array['pointages']
    else array[]::text[] end;
  who := s.role || coalesce(':' || s.entity, '') || ' / ' || coalesce(s.operateur, '');
  for e in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    t := e->>'type'; rid := e->>'id';
    ent := nullif(coalesce(e->'data'->>'prestataire', ''), '');
    select * into cur from public.tct_records where id = rid;
    if rid is null or not (t = any(allowed))
       or (found and cur.type <> t)
       or (s.role in ('presta','pointeur') and (ent is distinct from s.entity or (found and cur.entity is distinct from s.entity)))
       or (s.role = 'presta' and t = 'programmes' and not found)   -- un prestataire ne crée pas d'ordre
       or (s.role = 'site' and not found)                          -- le chef de site ne fait que contresigner
    then
      ko_ids := ko_ids || coalesce(rid, '?');
      continue;
    end if;
    insert into public.tct_records as r (id, type, entity, data, deleted, seq, updated_at, updated_by)
    values (rid, t, ent, coalesce(e->'data', '{}'::jsonb), coalesce((e->>'deleted')::boolean, false), nextval('public.tct_seq'), now(), who)
    on conflict (id) do update set
      data = excluded.data, deleted = excluded.deleted, entity = excluded.entity,
      seq = excluded.seq, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
    ok_ids := ok_ids || rid;
  end loop;
  return json_build_object('ok', ok_ids, 'rejected', ko_ids);
end $$;

-- Changement d'un code d'accès (donneur d'ordre uniquement)
create or replace function public.tct_set_code(p_token uuid, p_role text, p_entity text, p_code text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s public.tct_sessions;
begin
  s := public.tct_get_session(p_token);
  if s.role <> 'ct' then raise exception 'non_autorise'; end if;
  if p_code !~ '^[0-9]{4,8}$' then raise exception 'code_format'; end if;
  if p_role not in ('ct','agent','hse','site','presta') then raise exception 'role_inconnu'; end if;
  insert into public.tct_codes (role, entity, code_hash)
  values (p_role, case when p_role = 'presta' then coalesce(p_entity,'') else '' end, extensions.crypt(p_code, extensions.gen_salt('bf')))
  on conflict (role, entity) do update set code_hash = excluded.code_hash;
end $$;

revoke all on function public.tct_get_session(uuid) from public, anon, authenticated;
grant execute on function public.tct_login(text,text,text,text,text)   to anon;
grant execute on function public.tct_logout(uuid)                      to anon;
grant execute on function public.tct_pull(uuid,bigint,int)             to anon;
grant execute on function public.tct_push(uuid,jsonb)                  to anon;
grant execute on function public.tct_set_code(uuid,text,text,text)     to anon;

-- ---------- Photos ----------
-- Bucket public en lecture (noms de fichiers aléatoires), 1 Mo maximum, JPEG uniquement.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tct-photos', 'tct-photos', true, 1048576, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "tct_photos_ajout" on storage.objects;
create policy "tct_photos_ajout" on storage.objects
  for insert to anon with check (bucket_id = 'tct-photos');

notify pgrst, 'reload schema';

-- Vérification : doit afficher 11 codes
select role, entity from public.tct_codes order by role, entity;
