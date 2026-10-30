-- The app's name for an event: "World Cup #3", "World Tour #1", "European
-- Championships". ISU's names vary by year ("ISU World Cup 2019/20 - Salt
-- Lake City (USA)", "ISU World Cup Short Track Speed Skating"); the sync
-- worker sets this from the season's events in date order (eventNames).
alter table event add column short_name text;
comment on column event.short_name is 'Short display name, e.g. World Cup #3 or World Championships; stops are numbered within their season';
