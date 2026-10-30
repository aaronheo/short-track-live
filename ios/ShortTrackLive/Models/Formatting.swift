import Foundation

enum Fmt {
    private static let gregorian = Calendar(identifier: .gregorian)

    /// "2026-10-23" (a venue date, no time zone) → components.
    static func day(_ text: String) -> DateComponents? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return DateComponents(year: parts[0], month: parts[1], day: parts[2])
    }

    private static func monthName(_ month: Int) -> String {
        DateFormatter().shortMonthSymbols[month - 1]
    }

    /// "Oct 23–25", "Oct 30 – Nov 1", "Dec 30, 2026 – Jan 2, 2027".
    static func dateRange(_ start: String, _ end: String) -> String {
        guard let a = day(start), let b = day(end), let am = a.month, let bm = b.month, let ad = a.day, let bd = b.day else {
            return "\(start) – \(end)"
        }
        if a.year != b.year { return "\(monthName(am)) \(ad), \(a.year!) – \(monthName(bm)) \(bd), \(b.year!)" }
        if am == bm { return ad == bd ? "\(monthName(am)) \(ad)" : "\(monthName(am)) \(ad)–\(bd)" }
        return "\(monthName(am)) \(ad) – \(monthName(bm)) \(bd)"
    }

    /// ("OCT", "30") for the date block in event lists.
    static func dateBlock(_ start: String) -> (month: String, day: String) {
        guard let c = day(start), let m = c.month, let d = c.day else { return ("", "") }
        return (monthName(m).uppercased(), "\(d)")
    }

    /// "2026/2027" → "2026/27"
    static func season(_ title: String) -> String {
        let parts = title.split(separator: "/")
        guard parts.count == 2, parts[1].count == 4 else { return title }
        return "\(parts[0])/\(parts[1].suffix(2))"
    }

    /// 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd".
    static func ordinal(_ n: Int) -> String {
        let teen = (11...13).contains(n % 100)
        let suffix = teen ? "th" : [1: "st", 2: "nd", 3: "rd"][n % 10] ?? "th"
        return "\(n)\(suffix)"
    }

    /// "2026/2027" → "2026-2027" for the URL.
    static func seasonPath(_ title: String) -> String {
        title.replacingOccurrences(of: "/", with: "-")
    }

    /// 24-hour "16:41" in a time zone.
    static func clock(_ date: Date, in zone: TimeZone) -> String {
        var style = Date.FormatStyle(timeZone: zone).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        style.locale = Locale(identifier: "en_GB")
        return date.formatted(style)
    }

    /// "Fri 23" in a time zone.
    static func dayLabel(_ date: Date, in zone: TimeZone) -> String {
        var style = Date.FormatStyle(timeZone: zone).weekday(.abbreviated).day()
        style.locale = Locale(identifier: "en_US")
        return date.formatted(style).replacingOccurrences(of: ",", with: "")
    }

    /// "Fri Oct 30" in a time zone.
    static func weekdayMonthDay(_ date: Date, in zone: TimeZone) -> String {
        var style = Date.FormatStyle(timeZone: zone).weekday(.abbreviated).month(.abbreviated).day()
        style.locale = Locale(identifier: "en_US")
        return date.formatted(style).replacingOccurrences(of: ",", with: "")
    }

    /// "PT", "ET" in North America, "CET"/"CEST" in Europe, else "GMT+9" etc.
    static func zoneName(_ zone: TimeZone, at date: Date = .now) -> String {
        if let generic = zone.localizedName(for: .shortGeneric, locale: Locale(identifier: "en_US")),
           !generic.hasPrefix("GMT"), generic.count <= 4 {
            return generic
        }
        let style: NSTimeZone.NameStyle = zone.isDaylightSavingTime(for: date) ? .shortDaylightSaving : .shortStandard
        if let european = zone.localizedName(for: style, locale: Locale(identifier: "en_GB")), !european.hasPrefix("GMT+"),
           !european.hasPrefix("GMT-") {
            return european
        }
        return zone.abbreviation(for: date) ?? zone.identifier
    }

    /// "Seoul, South Korea": the system's short country name rather than
    /// ISU's ("Republic of Korea").
    static func place(_ event: EventSummary) -> String {
        [event.city, country(iso2: event.iso2, fallback: event.countryName)].compactMap { $0 }.joined(separator: ", ")
    }

    /// "South Korea", "Netherlands"; the fallback (ISU's name or code) when there's no ISO code.
    static func country(iso2: String?, fallback: String?) -> String? {
        iso2.flatMap { $0 == "CN" ? "China" : Locale(identifier: "en_US").localizedString(forRegionCode: $0) } ?? fallback
    }

    /// "2025-10-09" → "Oct 2025"
    static func monthYear(_ text: String) -> String? {
        guard let c = day(text), let m = c.month, let y = c.year else { return nil }
        return "\(monthName(m)) \(y)"
    }

    /// "Oct 23–25, 2026" (a date range with its year).
    static func dateRangeWithYear(_ start: String, _ end: String) -> String {
        let range = dateRange(start, end)
        guard let year = day(end)?.year, !range.contains(",") else { return range }
        return "\(range), \(year)"
    }
}
