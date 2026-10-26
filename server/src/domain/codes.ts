// IOC country codes (what ISU uses) → ISO 3166 alpha-2 (what flag emoji use).
const IOC_TO_ISO2: Record<string, string> = {
  ARG: 'AR', ARM: 'AM', AUS: 'AU', AUT: 'AT', AZE: 'AZ', BEL: 'BE', BLR: 'BY', BRA: 'BR', BUL: 'BG',
  CAN: 'CA', CHI: 'CL', CHN: 'CN', COL: 'CO', CRO: 'HR', CZE: 'CZ', DEN: 'DK', ESP: 'ES', EST: 'EE',
  FIN: 'FI', FRA: 'FR', GBR: 'GB', GEO: 'GE', GER: 'DE', GRE: 'GR', HKG: 'HK', HUN: 'HU', IND: 'IN',
  IRL: 'IE', ISL: 'IS', ISR: 'IL', ITA: 'IT', JPN: 'JP', KAZ: 'KZ', KOR: 'KR', LAT: 'LV', LTU: 'LT',
  LUX: 'LU', MAS: 'MY', MEX: 'MX', MGL: 'MN', MON: 'MC', NED: 'NL', NOR: 'NO', NZL: 'NZ', PHI: 'PH',
  POL: 'PL', POR: 'PT', PRK: 'KP', ROU: 'RO', RSA: 'ZA', RUS: 'RU', SGP: 'SG', SLO: 'SI', SRB: 'RS',
  SUI: 'CH', SVK: 'SK', SWE: 'SE', THA: 'TH', TPE: 'TW', TUR: 'TR', UKR: 'UA', USA: 'US', UZB: 'UZ',
};

/** ISO alpha-2 for an IOC code; null when there's no flag (e.g. AIN neutral athletes). */
export function iso2(ioc: string | null | undefined): string | null {
  return (ioc && IOC_TO_ISO2[ioc]) ?? null;
}

/** ISU result_status → our short code. */
const RESULT_STATUS: Record<string, string> = {
  Penalty: 'PEN', 'Yellow Card': 'YC', 'Red Card': 'RC', 'Did Not Finish': 'DNF', 'Did Not Start': 'DNS',
};
const RESULT_TEXT = new Set(['PEN', 'YC', 'RC', 'DNF', 'DNS']);

export function statusCode(resultStatus: string | null | undefined, finalResult: string | null | undefined): string | null {
  return RESULT_STATUS[resultStatus ?? ''] ?? (RESULT_TEXT.has(finalResult ?? '') ? finalResult! : null);
}

/** Qualifies outright for the next round (or Final A from a semifinal). */
export const AUTO_CODES = new Set(['Q', 'QA']);
/** Qualifies on time. */
export const TIME_CODES = new Set(['q', 'qA']);
/** Advanced by the referee; takes a time spot in 11 of the 12 rounds we checked. */
export const ADVANCED_CODES = new Set(['ADV', 'ADVA']);
/** Every code shown as a solid badge. */
export const QUALIFIED_CODES = new Set(['Q', 'q', 'QA', 'QB', 'qA', 'qB', 'ADV', 'ADVA', 'ADVB']);
