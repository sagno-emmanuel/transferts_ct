-- =====================================================================
-- Transferts CT — version 4.2 : référentiels modifiables sans code
-- À exécuter une fois, APRÈS 01_installation.sql et 02_connexion.sql.
-- Supabase > SQL Editor > New query > coller > Run
-- ---------------------------------------------------------------------
-- La liste des prestataires et les plaques de leurs camions ne sont plus
-- écrites dans le programme : le donneur d'ordre les modifie dans
-- Réglages > Prestataires et camions, et tous les appareils les reçoivent.
-- =====================================================================

-- Lecture : le référentiel est visible de tous les accès connectés
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
        r.type = 'referentiels'
        or s.role in ('ct','agent','hse')
        or (s.role = 'site' and r.type in ('programmes','pointages'))
        or (s.role = 'presta' and r.entity = s.entity and r.type in ('programmes','flotte','retraits','voyages','pointages'))
        or (s.role = 'pointeur' and r.entity = s.entity and r.type = 'pointages')
      )
    order by r.seq
    limit least(greatest(coalesce(p_limit, 300), 1), 500);
end $$;

-- Écriture : seul le donneur d'ordre modifie le référentiel
create or replace function public.tct_push(p_token uuid, p_rows jsonb)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.tct_sessions; e jsonb; t text; rid text; ent text; cur public.tct_records;
  allowed text[]; ok_ids text[] := '{}'; ko_ids text[] := '{}'; who text;
begin
  s := public.tct_get_session(p_token);
  allowed := case s.role
    when 'ct'       then array['programmes','flotte','retraits','voyages','pointages','convois','settings','referentiels']
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

-- Référentiel initial (repris de la version 4.1) ; sans effet s'il existe déjà
insert into public.tct_records (id, type, entity, data, updated_by) values ('__referentiels__', 'referentiels', null, $json${
  "prestataires": ["AGL","EDT","GOS","GSL","COPRELOG","IKT","NLS"],
  "flotte": {
    "AGL": ["BL-5433-02","BL-5392-02","BL-5393-02","BL-5462-02","BL-5494-02","BL-5398-02","BL-5488-02","BL-5439-02","BL-5480-02","BL-5496-02","BL-5474-02","BL-5371-02","BL-5388-02","BL-5427-02","BL-5443-02","BL-5425-02","BL-5380-02","BL-5472-02","BL-5421-02","BL-5435-02","BL-5484-02","BL-5508-02","BL-5475-02","BL-5513-02","BL-5418-02","BL-5468-02","BL-5402-02","BL-5504-02","BL-5518-02"],
    "EDT": ["BA6898","BA6912","BA6890","BA6885","BA6904","BA6894","BA6901","BA6909","BE2601","BK6339","BG5302","BG5293","AX0843","AX0839","BJ3617","BJ3613","BH2489"],
    "GOS": ["BJ4726","BC6056","BC6057","BC6058","BI0132","BE2956","BG0937","BH2293","BH2304","BF5799","BB9364","BB9365","BB9366","BB2084","BI0158","RC3238","BI0154","BI0153","BG0924"],
    "COPRELOG": ["BN-2052-02","BD-2231-02","BD-2232-02","BD-2234-02","BD-3753-02","BK-1119-02","BC-8234-02","AW-9714-02","AY-6839-02","BE-6977-02","BE-6978-02","BI-5398-02","BI-3888-02","BI-3931-02","BI-3934-02","BI-4032-02","BI-4072-02","BI-4083-02","BK-4935-02","BL-0061-02","BK-9817-02"],
    "IKT": ["AH3224","AH3231","AF7757","AL3915","AN8309","BA4473","BF1344","BF1355","RC3943","RC5467","BL3592","BL3588","BL3616"],
    "GSL": ["BA7275-02","BA7278-02","BA7279-02","BA7314-02","BA7293-02","BA7308-02","BA7286-02","BA7298-02","BA7276-02","BA7306-02"],
    "NLS": ["BL-4236-02","BL-4180-02","BL-4182-02","BA-0520-02","BA-0521-02"]
  }
}$json$::jsonb, 'installation')
on conflict (id) do nothing;

notify pgrst, 'reload schema';

-- Vérification : doit afficher 1 ligne « referentiels »
select id, type, jsonb_array_length(data->'prestataires') as nb_prestataires from public.tct_records where type = 'referentiels';
