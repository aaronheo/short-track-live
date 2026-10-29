// Shapes returned by ISU's undocumented results API (front-api.isu.org), as
// read from isu-skating.com's JS bundles in Oct 2026. Only the fields we use.

export interface IsuSeason {
  season_id: string;
  title: string; // "2025/2026"
  from: string;
  to: string;
  is_current: 0 | 1;
}

export interface IsuEvent {
  id?: string | null;
  event_id?: string | null;
  api_id?: string | null;
  slug: string;
  name: string;
  season: string; // "2025/2026"
  season_id: string;
  from_date: string; // local midnight with a "Z" suffix
  to_date: string;
  from_date_utc?: string;
  time_zone: string; // IANA; sometimes wrong (Montréal 2025 says America/Halifax)
  city?: string | null;
  country_code?: string | null;
  country_name?: string | null;
  event_sub_type_name?: string | null; // "ISU World Tour", "Olympic Games", ...
  state: string; // "On" (upcoming) | "Live" | "Finished" | ...
}

export interface IsuScheduleItem {
  start_time: string; // real UTC
  event_schedule_title: string;
  round_information: string;
  event_result_id: number | null; // null for the Olympics
  event_result_round_id: number | null;
  discipline_type: string | null;
}

export interface IsuCompetition {
  event_result_id: number;
  event_id: number;
  api_id?: string | null;
  name: string; // "Men 500 m"
  gender: string;
  discipline_distance: string; // "500"; "" when unknown
  discipline_type: string; // "Singles" | "Couples" (relays)
  display_order: number | null;
  status: string; // "Scheduled" | "In Progress" | "Live" | "Finished"
}

export interface IsuRound {
  event_result_round_id: number;
  event_result_id: number;
  name: string; // "Quarterfinals"
  display_order: number;
  status: string;
  date: string | null; // real UTC (for the current season)
  qualification_rule: string | null;
}

export interface IsuLap {
  LapNumber: string;
  Rank: number | null;
  LapTime: string;
  Time: string;
  ResultDiff: string;
}

export interface IsuSkater {
  id: number;
  api_id?: string | null;
  slug?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  gender?: string | null;
  nationality_code?: string | null;
  thumbnail_image?: string | null;
}

export interface IsuTeam {
  id: number;
  api_id?: string | null;
  slug?: string | null;
  name: string;
  nf_organization_code?: string | null;
  gender?: string | null;
}

export interface IsuTeamMember {
  skaters?: IsuSkater | null;
}

export interface IsuCompetitor {
  event_result_round_heats_competitors_id: number;
  skaters_id: number | null;
  skaters_team_id: number | null;
  bib_number: number | null;
  starting_position: number | null;
  final_rank: number | null;
  final_result: string; // "1:24.537" | "PEN" | "YC" | "DNF" | "DNS" | "no time"
  result_status: string; // "" | "Penalty" | "Yellow Card" | "Did Not Finish" | "Did Not Start"
  qualification_code: string; // "" | Q | q | p | QA | QB | qA | qB | ADV | ADVA | ADVB
  record_flag: string;
  started_for_nf_code: string | null;
  started_for_nf_country_name: string | null;
  skaters: IsuSkater | null;
  skaters_team: IsuTeam | null;
  event_result_round_heats_competitors_team_members?: IsuTeamMember[] | null;
  lap?: IsuLap[] | null;
}

export interface IsuHeat {
  event_result_round_heats_id: number;
  api_id?: string | null;
  name: string; // "Heat 3" | "Final A"
  display_order: number;
  status: string; // "Scheduled" | "Live" | "Finished"
  result_status: string; // "" | "Start List" | "Live" | "Official"
  date: string | null; // local wall-clock time with a "Z" suffix
  updated_at: string | null;
  event_result_round_heats_competitors: IsuCompetitor[] | null;
}

/** One event with everything under it, as `IsuClient.pullEvent` returns it. */
export interface EventTree {
  event: IsuEvent;
  schedule: IsuScheduleItem[];
  competitions: (IsuCompetition & { rounds: (IsuRound & { heats: IsuHeat[] })[] })[];
}

/** One of ISU's published standings (World Tour classifications and World Rankings). */
export interface IsuStandingList {
  world_standings_list_fsk_id: number;
  season_id: number; // ISU's, our season.isu_id
  name: string; // "Overall World Tour Classification Women"
  gender: string; // "Men" | "Women" | "Mixed"; "" before 2024/25
  discipline_name: string; // "Women 500 m", "Men Relay 5000 m", "Mixed Relay 2000 m"; "" for overall
  type: string; // WCO overall, WCT nations, WCD by distance; WRO/WRD World Ranking
  team_type: string; // "Singles" | "Couples" (relays, nations)
  calculation_date: string | null;
  updated_at: string;
}

export interface IsuStandingEntry {
  rank: number | null; // ties share a rank; null in a few broken past lists
  rank_index: number | null; // order
  points: number;
  nf_for_country_code: string | null;
  skaters_type: string; // "Single" | "Team"
  skaters?: { api_id: string | null; first_name: string | null; last_name: string; nationality_code: string | null; gender?: string | null } | null;
  skaters_team?: { api_id: string | null; name: string; nf_organization_code: string | null } | null;
  /** One per World Tour stop, in order; `result` is "" where nothing was scored (yet). */
  world_standings_list_stk_competitors_competition_points: {
    country: string; // "CAN1", "KOR"
    display_order: number;
    result: string; // "100"; "(60)" a result that doesn't count (relays keep their best ones)
    date: string | null;
    name: string; // "ISU Short Track World Tour 2026/27 - Vancouver (CAN)" once raced
  }[];
}
