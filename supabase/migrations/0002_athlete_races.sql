-- Athlete pages look up the relays a skater was in.
create index if not exists relay_member_skater_id_idx on relay_member (skater_id);
