// IOC country codes (what ISU uses) → ISO 3166 alpha-2 (what flag emoji use).
const IOC_TO_ISO2: Record<string, string> = {
  ARG: 'AR', ARM: 'AM', AUS: 'AU', AUT: 'AT', AZE: 'AZ', BEL: 'BE', BLR: 'BY', BRA: 'BR', BUL: 'BG',
  CAN: 'CA', CHI: 'CL', CHN: 'CN', COL: 'CO', CRO: 'HR', CZE: 'CZ', DEN: 'DK', ESP: 'ES', EST: 'EE',
  FIN: 'FI', FRA: 'FR', GBR: 'GB', GEO: 'GE', GER: 'DE', GRE: 'GR', HKG: 'HK', HUN: 'HU', IND: 'IN',
  IRL: 'IE', ISL: 'IS', ISR: 'IL', ITA: 'IT', JPN: 'JP', KAZ: 'KZ', KOR: 'KR', LAT: 'LV', LTU: 'LT',
  LUX: 'LU', MAS: 'MY', MEX: 'MX', MGL: 'MN', MON: 'MC', NED: 'NL', NOR: 'NO', NZL: 'NZ', PHI: 'PH',
  POL: 'PL', POR: 'PT', PRK: 'KP', ROU: 'RO', RSA: 'ZA', RUS: 'RU', SGP: 'SG', SLO: 'SI', SRB: 'RS',
  SUI: 'CH', SVK: 'SK', SWE: 'SE', THA: 'TH', TPE: 'TW', TUR: 'TR', UKR: 'UA', USA: 'US', UZB: 'UZ',
  ALB: 'AL', AND: 'AD', BIH: 'BA', CYP: 'CY', INA: 'ID', LIE: 'LI', MDA: 'MD', MKD: 'MK', MNE: 'ME',
};

/** ISU's formal country names, shortened for relay teams and event places. */
const SHORT_COUNTRY: Record<string, string> = {
  "People's Republic of China": 'China',
  'Republic of Korea': 'Korea',
  "Democratic People's Republic of Korea": 'North Korea',
  'United States of America': 'United States',
  'Islamic Republic of Iran': 'Iran',
  'Republic of Moldova': 'Moldova',
  'Russian Federation': 'Russia',
  'Kingdom of the Netherlands': 'Netherlands',
  'Hong Kong, China': 'Hong Kong',
};

export function shortCountry(name: string): string {
  return SHORT_COUNTRY[name.trim()] ?? name;
}

/** ISO alpha-2 for an IOC code; null when there's no flag (e.g. AIN neutral athletes). */
export function iso2(ioc: string | null | undefined): string | null {
  return (ioc && IOC_TO_ISO2[ioc]) ?? null;
}

/** ISU result_status → our short code. */
const RESULT_STATUS: Record<string, string> = {
  Penalty: 'PEN', 'Yellow Card': 'YC', 'Red Card': 'RC', 'Did Not Finish': 'DNF', 'Did Not Start': 'DNS',
};
const RESULT_TEXT = new Set(['PEN', 'YC', 'RC', 'DNF', 'DNS', 'WDR']);
// Older events write some outcomes in the time field instead.
const TEXT_ALIASES: Record<string, string> = { DQ: 'PEN' };

export function statusCode(resultStatus: string | null | undefined, finalResult: string | null | undefined): string | null {
  const text = TEXT_ALIASES[finalResult ?? ''] ?? finalResult ?? '';
  return RESULT_STATUS[resultStatus ?? ''] ?? (RESULT_TEXT.has(text) ? text : null);
}

/** Qualifies outright for the next round (or Final A from a semifinal). */
export const AUTO_CODES = new Set(['Q', 'QA']);
/** Qualifies on time. */
export const TIME_CODES = new Set(['q', 'qA']);
/** Advanced by the referee; takes a time spot in 11 of the 12 rounds we checked. */
export const ADVANCED_CODES = new Set(['ADV', 'ADVA']);
/** Every code shown as a solid badge. */
export const QUALIFIED_CODES = new Set(['Q', 'q', 'QA', 'QB', 'qA', 'qB', 'ADV', 'ADVA', 'ADVB']);
