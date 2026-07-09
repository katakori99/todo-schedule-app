begin;

-- Additive migration: existing rows remain root tasks because parent_id is null.
alter table public.todo_items
  add column if not exists parent_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'todo_items_parent_id_fkey'
      and conrelid = 'public.todo_items'::regclass
  ) then
    alter table public.todo_items
      add constraint todo_items_parent_id_fkey
      foreign key (parent_id)
      references public.todo_items (id)
      on delete cascade;
  end if;
end
$$;

create index if not exists todo_items_user_parent_order_idx
  on public.todo_items (user_id, parent_id, order_index, created_at);

-- Keep trigger-only validation code outside the exposed public schema.
create schema if not exists todo_private;
revoke all on schema todo_private from public;
revoke all on schema todo_private from anon;
revoke all on schema todo_private from authenticated;

create or replace function todo_private.validate_todo_item_parent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_user_id uuid;
  v_parent_parent_id uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'A todo item cannot be its own parent.'
      using errcode = '23514';
  end if;

  select parent.user_id, parent.parent_id
  into v_parent_user_id, v_parent_parent_id
  from public.todo_items as parent
  where parent.id = new.parent_id;

  if not found then
    raise exception 'The selected parent todo item does not exist.'
      using errcode = '23503';
  end if;

  if v_parent_user_id is distinct from new.user_id then
    raise exception 'A todo item and its parent must belong to the same user.'
      using errcode = '42501';
  end if;

  if v_parent_parent_id is not null then
    raise exception 'Todo items support only one subtask level.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function todo_private.validate_todo_item_parent() from public;
revoke all on function todo_private.validate_todo_item_parent() from anon;
revoke all on function todo_private.validate_todo_item_parent() from authenticated;

drop trigger if exists todo_items_validate_parent_insert on public.todo_items;
create trigger todo_items_validate_parent_insert
before insert on public.todo_items
for each row
execute function todo_private.validate_todo_item_parent();

drop trigger if exists todo_items_validate_parent_update on public.todo_items;
create trigger todo_items_validate_parent_update
before update of parent_id, user_id on public.todo_items
for each row
execute function todo_private.validate_todo_item_parent();

-- Create a child and reopen its parent in one transaction.
create or replace function public.add_todo_child(
  p_parent_id uuid,
  p_content_html text
)
returns public.todo_items
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_order_index integer;
  v_child public.todo_items;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if p_content_html is null or btrim(p_content_html) = '' then
    raise exception 'Subtask content cannot be empty.'
      using errcode = '23514';
  end if;

  perform 1
  from public.todo_items as parent
  where parent.id = p_parent_id
    and parent.user_id = v_user_id
    and parent.parent_id is null
  for update;

  if not found then
    raise exception 'The parent todo item was not found.'
      using errcode = 'P0002';
  end if;

  select coalesce(max(child.order_index), -1) + 1
  into v_order_index
  from public.todo_items as child
  where child.user_id = v_user_id
    and child.parent_id = p_parent_id;

  insert into public.todo_items (
    user_id,
    parent_id,
    content_html,
    done,
    order_index
  )
  values (
    v_user_id,
    p_parent_id,
    btrim(p_content_html),
    false,
    v_order_index
  )
  returning * into v_child;

  update public.todo_items
  set done = false
  where id = p_parent_id
    and user_id = v_user_id;

  return v_child;
end;
$$;

-- Update a task tree atomically and return the refreshed parent and children.
create or replace function public.set_todo_item_done(
  p_item_id uuid,
  p_done boolean
)
returns setof public.todo_items
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_parent_id uuid;
  v_root_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if p_done is null then
    raise exception 'The done state is required.'
      using errcode = '23502';
  end if;

  select item.parent_id
  into v_parent_id
  from public.todo_items as item
  where item.id = p_item_id
    and item.user_id = v_user_id;

  if not found then
    raise exception 'The todo item was not found.'
      using errcode = 'P0002';
  end if;

  v_root_id := coalesce(v_parent_id, p_item_id);

  -- Every completion operation locks the root first, then children by UUID.
  perform 1
  from public.todo_items as root
  where root.id = v_root_id
    and root.user_id = v_user_id
  for update;

  perform 1
  from public.todo_items as child
  where child.parent_id = v_root_id
    and child.user_id = v_user_id
  order by child.id
  for update;

  if v_parent_id is null then
    if p_done then
      update public.todo_items
      set done = true
      where user_id = v_user_id
        and (id = p_item_id or parent_id = p_item_id);
    else
      update public.todo_items
      set done = false
      where id = p_item_id
        and user_id = v_user_id;
    end if;
  else
    update public.todo_items
    set done = p_done
    where id = p_item_id
      and user_id = v_user_id;

    update public.todo_items as parent
    set done = not exists (
      select 1
      from public.todo_items as child
      where child.parent_id = v_root_id
        and child.user_id = v_user_id
        and child.done = false
    )
    where parent.id = v_root_id
      and parent.user_id = v_user_id;
  end if;

  return query
  select item.*
  from public.todo_items as item
  where item.user_id = v_user_id
    and (item.id = v_root_id or item.parent_id = v_root_id)
  order by
    case when item.id = v_root_id then 0 else 1 end,
    item.order_index,
    item.created_at;
end;
$$;

-- Reorder only a complete sibling set. Missing, duplicate, or foreign IDs fail.
create or replace function public.reorder_todo_siblings(
  p_parent_id uuid,
  p_ordered_ids uuid[]
)
returns setof public.todo_items
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_requested_count integer := coalesce(cardinality(p_ordered_ids), 0);
  v_distinct_count integer;
  v_sibling_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if p_parent_id is not null then
    perform 1
    from public.todo_items as parent
    where parent.id = p_parent_id
      and parent.user_id = v_user_id
      and parent.parent_id is null
    for update;

    if not found then
      raise exception 'The parent todo item was not found.'
        using errcode = 'P0002';
    end if;
  end if;

  select count(distinct requested.id)
  into v_distinct_count
  from unnest(coalesce(p_ordered_ids, array[]::uuid[])) as requested(id);

  if v_requested_count <> v_distinct_count then
    raise exception 'The ordered todo IDs contain duplicates.'
      using errcode = '22023';
  end if;

  perform 1
  from public.todo_items as sibling
  where sibling.user_id = v_user_id
    and sibling.parent_id is not distinct from p_parent_id
  order by sibling.id
  for update;

  select count(*)
  into v_sibling_count
  from public.todo_items as sibling
  where sibling.user_id = v_user_id
    and sibling.parent_id is not distinct from p_parent_id;

  if v_sibling_count <> v_requested_count
    or exists (
      select 1
      from public.todo_items as sibling
      where sibling.user_id = v_user_id
        and sibling.parent_id is not distinct from p_parent_id
        and not (sibling.id = any(coalesce(p_ordered_ids, array[]::uuid[])))
    )
  then
    raise exception 'The ordered todo IDs do not match the current sibling set.'
      using errcode = '22023';
  end if;

  with requested as (
    select
      entry.id,
      (entry.position - 1)::integer as next_order_index
    from unnest(coalesce(p_ordered_ids, array[]::uuid[]))
      with ordinality as entry(id, position)
  )
  update public.todo_items as item
  set order_index = requested.next_order_index
  from requested
  where item.id = requested.id
    and item.user_id = v_user_id
    and item.parent_id is not distinct from p_parent_id;

  return query
  select sibling.*
  from public.todo_items as sibling
  where sibling.user_id = v_user_id
    and sibling.parent_id is not distinct from p_parent_id
  order by sibling.order_index, sibling.created_at;
end;
$$;

revoke execute on function public.add_todo_child(uuid, text) from public;
revoke execute on function public.add_todo_child(uuid, text) from anon;
grant execute on function public.add_todo_child(uuid, text) to authenticated;

revoke execute on function public.set_todo_item_done(uuid, boolean) from public;
revoke execute on function public.set_todo_item_done(uuid, boolean) from anon;
grant execute on function public.set_todo_item_done(uuid, boolean) to authenticated;

revoke execute on function public.reorder_todo_siblings(uuid, uuid[]) from public;
revoke execute on function public.reorder_todo_siblings(uuid, uuid[]) from anon;
grant execute on function public.reorder_todo_siblings(uuid, uuid[]) to authenticated;

commit;
