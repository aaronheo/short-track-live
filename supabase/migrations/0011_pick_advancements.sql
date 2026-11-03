-- Keep referee advancements distinct from penalty predictions in picks.
alter table pick add column advanced bigint[] not null default '{}';
