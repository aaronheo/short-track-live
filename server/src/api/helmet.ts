/**
 * A skater's helmet cover number this season (ISU's bib): their place in last
 * season's World Tour. Taken from their latest race this season, World Tour
 * first (other championships number skaters their own way). This season is
 * the latest event's that has started; null before their first race in it. `skater` is the SQL for the skater's id.
 */
export const helmetSql = (skater: string) => `(
  select en.bib from entry en
  join heat h on h.id = en.heat_id join round r on r.id = h.round_id
  join competition c on c.id = r.competition_id join event e on e.id = c.event_id
  where en.skater_id = ${skater} and en.bib is not null
    and e.season_id = (select season_id from event where starts_on <= current_date order by starts_on desc limit 1)
  order by e.series ilike '%world tour%' desc, e.starts_on desc limit 1)`;
