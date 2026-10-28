-- Only events ISU has no results for at all are left out of the app; ones
-- with gaps stay, showing "No time" where results are missing.
alter table event rename column incomplete to no_results;
comment on column event.no_results is 'Settled with no results at ISU (cancelled, or never published); left out of the app';
