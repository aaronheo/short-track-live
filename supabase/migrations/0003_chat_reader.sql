-- A read-only role for the Ask feature's SQL tool. The server switches to it
-- (set local role) for model-written queries, so they can only read results.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chat_reader') then
    create role chat_reader nologin;
  end if;
end $$;

grant usage on schema public to chat_reader;
grant select on season, event, competition, round, schedule_item, heat, skater, relay_team, entry, relay_member, lap, nation to chat_reader;
grant chat_reader to postgres;

-- Row Level Security is on with no policies (only the owner reads); let this role read too.
create policy chat_reader_read on season for select to chat_reader using (true);
create policy chat_reader_read on event for select to chat_reader using (true);
create policy chat_reader_read on competition for select to chat_reader using (true);
create policy chat_reader_read on round for select to chat_reader using (true);
create policy chat_reader_read on schedule_item for select to chat_reader using (true);
create policy chat_reader_read on heat for select to chat_reader using (true);
create policy chat_reader_read on skater for select to chat_reader using (true);
create policy chat_reader_read on relay_team for select to chat_reader using (true);
create policy chat_reader_read on entry for select to chat_reader using (true);
create policy chat_reader_read on relay_member for select to chat_reader using (true);
create policy chat_reader_read on lap for select to chat_reader using (true);
create policy chat_reader_read on nation for select to chat_reader using (true);
