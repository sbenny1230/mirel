-- Mirel initial schema.
--
-- Privacy model: the server stores only routing metadata (ids, space
-- membership, sequence numbers, timestamps) and ciphertext. All user content,
-- including what *kind* of thing a record is, is end-to-end encrypted on the
-- device. Clients can't write `records` directly; all writes go through
-- push_records(), which enforces membership and optimistic concurrency.

-- ---------------------------------------------------------------------------
-- Vault bundles (encrypted key material; see src/lib/crypto/vault.ts)
-- ---------------------------------------------------------------------------
create table public.user_keys (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  public_key text not null,
  bundle     jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bundle_size check (pg_column_size(bundle) < 16384)
);

-- ---------------------------------------------------------------------------
-- Spaces: a personal "My people" space per user, plus shared spaces.
-- Names and everything else about a space live in encrypted records.
-- ---------------------------------------------------------------------------
create table public.spaces (
  id         uuid primary key,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.space_members (
  space_id   uuid not null references public.spaces (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index space_members_user on public.space_members (user_id);

-- Each member's copy of each space key version, sealed to their public key.
create table public.space_keys (
  space_id    uuid not null references public.spaces (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  key_version int not null check (key_version > 0),
  sealed_key  text not null check (length(sealed_key) < 1024),
  created_at  timestamptz not null default now(),
  primary key (space_id, user_id, key_version)
);

-- ---------------------------------------------------------------------------
-- Records: every person, note, gift idea, occasion... as ciphertext.
-- ---------------------------------------------------------------------------
create sequence public.records_seq as bigint;

create table public.records (
  id          uuid primary key,
  space_id    uuid not null references public.spaces (id) on delete cascade,
  key_version int not null check (key_version > 0),
  ciphertext  text,
  deleted     boolean not null default false,
  seq         bigint not null,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  -- Tombstones keep no content.
  constraint tombstone_has_no_content check (deleted = (ciphertext is null)),
  constraint ciphertext_size check (ciphertext is null or length(ciphertext) <= 262144)
);
create index records_space_seq on public.records (space_id, seq);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.is_space_member(p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.space_members m
    where m.space_id = p_space_id and m.user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-level security. No INSERT/UPDATE/DELETE policies on spaces, members,
-- keys or records: those writes only happen through the functions below.
-- ---------------------------------------------------------------------------
alter table public.user_keys     enable row level security;
alter table public.spaces        enable row level security;
alter table public.space_members enable row level security;
alter table public.space_keys    enable row level security;
alter table public.records       enable row level security;

create policy "own vault: read"   on public.user_keys for select to authenticated using (user_id = (select auth.uid()));
create policy "own vault: create" on public.user_keys for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own vault: update" on public.user_keys for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "members read spaces"  on public.spaces        for select to authenticated using (public.is_space_member(id));
create policy "members read members" on public.space_members for select to authenticated using (public.is_space_member(space_id));
create policy "read own space keys"  on public.space_keys    for select to authenticated using (user_id = (select auth.uid()));
create policy "members read records" on public.records       for select to authenticated using (public.is_space_member(space_id));

revoke all on public.user_keys, public.spaces, public.space_members, public.space_keys, public.records from anon;
revoke insert, update, delete, truncate on public.spaces, public.space_members, public.space_keys, public.records from authenticated;
revoke delete, truncate on public.user_keys from authenticated;

-- ---------------------------------------------------------------------------
-- create_space: creates a space with the caller as owner and stores their
-- sealed copy of key version 1.
-- ---------------------------------------------------------------------------
create function public.create_space(p_space_id uuid, p_sealed_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.spaces (id, created_by) values (p_space_id, v_uid);
  insert into public.space_members (space_id, user_id, role) values (p_space_id, v_uid, 'owner');
  insert into public.space_keys (space_id, user_id, key_version, sealed_key) values (p_space_id, v_uid, 1, p_sealed_key);
end;
$$;

-- ---------------------------------------------------------------------------
-- push_records: batched writes with optimistic concurrency.
--
-- Each change carries baseSeq, the seq the client's edit was based on. If the
-- server row has moved on, the change is rejected and the current row is
-- returned so the client can merge (the server can't read the data, so it
-- can't merge). Accepted writes get a new seq from a global sequence.
--
-- Per-space advisory locks (taken in a fixed order to avoid deadlocks) mean
-- that within a space, seq order equals commit order, so a client pulling
-- "seq > cursor" never skips a row that commits late.
-- ---------------------------------------------------------------------------
create function public.push_records(changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_change  jsonb;
  v_space   uuid;
  v_id      uuid;
  v_base    bigint;
  v_deleted boolean;
  v_cipher  text;
  v_seq     bigint;
  v_cur     public.records%rowtype;
  v_out     jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) > 500 then
    raise exception 'changes must be an array of at most 500 items' using errcode = '22023';
  end if;

  for v_space in
    select distinct (e ->> 'spaceId')::uuid from jsonb_array_elements(changes) e order by 1
  loop
    if not public.is_space_member(v_space) then
      raise exception 'not a member of space %', v_space using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('mirel.space.' || v_space::text, 0));
  end loop;

  for v_change in select * from jsonb_array_elements(changes)
  loop
    v_id      := (v_change ->> 'id')::uuid;
    v_space   := (v_change ->> 'spaceId')::uuid;
    v_base    := (v_change ->> 'baseSeq')::bigint;
    v_deleted := coalesce((v_change ->> 'deleted')::boolean, false);
    v_cipher  := case when v_deleted then null else v_change ->> 'ciphertext' end;

    select * into v_cur from public.records r where r.id = v_id for update;

    if found and v_cur.space_id <> v_space then
      raise exception 'record % belongs to another space', v_id using errcode = '42501';
    end if;

    if found and v_cur.seq is distinct from v_base then
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id', v_id,
        'status', 'conflict',
        'current', jsonb_build_object(
          'id', v_cur.id,
          'spaceId', v_cur.space_id,
          'keyVersion', v_cur.key_version,
          'ciphertext', v_cur.ciphertext,
          'deleted', v_cur.deleted,
          'seq', v_cur.seq
        )
      ));
      continue;
    end if;

    v_seq := nextval('public.records_seq');
    insert into public.records as r (id, space_id, key_version, ciphertext, deleted, seq, updated_by, updated_at)
    values (v_id, v_space, (v_change ->> 'keyVersion')::int, v_cipher, v_deleted, v_seq, v_uid, now())
    on conflict (id) do update set
      key_version = excluded.key_version,
      ciphertext  = excluded.ciphertext,
      deleted     = excluded.deleted,
      seq         = excluded.seq,
      updated_by  = excluded.updated_by,
      updated_at  = excluded.updated_at;

    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'status', 'ok', 'seq', v_seq));
  end loop;

  return v_out;
end;
$$;

revoke execute on function public.is_space_member(uuid), public.create_space(uuid, text), public.push_records(jsonb) from public, anon;
grant execute on function public.is_space_member(uuid), public.create_space(uuid, text), public.push_records(jsonb) to authenticated;

-- Realtime "something changed" pings. Rows are ciphertext and RLS applies.
alter publication supabase_realtime add table public.records;
