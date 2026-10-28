-- An event whose results ISU only has part of, a week after it ended (some
-- skaters with no place, time or status). Its results are dropped and the
-- event is left out of the app; the row stays so the sync doesn't refetch it.
alter table event add column incomplete boolean not null default false;
