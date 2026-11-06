import Foundation
import SQLite3

struct SourceCursor {
    var dateNanoseconds: Int64
    var rowID: Int64
}

struct SourceOptions {
    var databasePath: String
    var afterCursor: SourceCursor
    var limit: Int32
    var newest: Bool
}

func optionValue(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

func parseInt64(_ value: String, option: String) -> Int64 {
    guard let parsed = Int64(value), parsed >= 0 else {
        fail("Invalid \(option): expected a non-negative decimal integer")
    }
    return parsed
}

func parseCursor(_ value: String) -> SourceCursor {
    let parts = value.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2,
          let dateNanoseconds = Int64(parts[0]),
          let rowID = Int64(parts[1]),
          dateNanoseconds >= 0,
          rowID >= 0 else {
        fail("Invalid --after-cursor: expected dateNanoseconds:rowID")
    }
    return SourceCursor(dateNanoseconds: dateNanoseconds, rowID: rowID)
}

func parseOptions() -> SourceOptions {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let defaultPath = home + "/Library/Messages/chat.db"
    let cursor: SourceCursor
    if let rawCursor = optionValue("--after-cursor", in: arguments) ?? optionValue("--since-cursor", in: arguments) {
        cursor = parseCursor(rawCursor)
    } else {
        let since = optionValue("--since-ns", in: arguments) ?? "0"
        // The legacy numeric cursor was strictly date-only. Using the largest row ID
        // keeps messages sharing that timestamp excluded while preserving the old `date > since` behavior.
        cursor = SourceCursor(dateNanoseconds: parseInt64(since, option: "--since-ns"), rowID: Int64.max)
    }
    let rawLimit = optionValue("--limit", in: arguments) ?? "500"
    guard let parsedLimit = Int(rawLimit), parsedLimit > 0 else {
        fail("Invalid --limit: expected a positive integer")
    }
    return SourceOptions(
        databasePath: optionValue("--db", in: arguments) ?? defaultPath,
        afterCursor: cursor,
        limit: Int32(min(parsedLimit, 5000)),
        newest: arguments.contains("--newest")
    )
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func cursorValue(dateNanoseconds: Int64, rowID: Int64) -> String {
    return "\(dateNanoseconds):\(rowID)"
}

func cleanAttributedCandidate(_ value: String) -> String? {
    var candidate = value.trimmingCharacters(in: .whitespacesAndNewlines)
    candidate = candidate.replacingOccurrences(of: "^\\+p\\s*", with: "", options: .regularExpression)
    candidate = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    guard candidate.count >= 8 else { return nil }
    return candidate
}

func transactionLikeContent(_ value: String) -> Bool {
    let markerPattern = "(?:EGP|LE|L\\.?E\\.?|ج\\.?\\s*م|جنيه|جنية|خصم|إضافة|اضافة|تحويل|شراء|دفع|سحب|إيداع|ايداع|بطاقة|حساب|رصيد|مبلغ|debit|credit|transfer|payment|purchase|withdrawal|deposit|card|account)"
    let numberPattern = "[0-9٠-٩۰-۹]"
    let hasMarker = value.range(of: markerPattern, options: [.regularExpression, .caseInsensitive]) != nil
    let hasNumber = value.range(of: numberPattern, options: .regularExpression) != nil
    return hasMarker && hasNumber
}

func foundationText(_ object: Any) -> String? {
    if let attributed = object as? NSAttributedString {
        return attributed.string
    }
    if let string = object as? NSString {
        return string as String
    }
    if let string = object as? String {
        return string
    }
    return nil
}

func decodeFoundationText(_ data: Data) -> String? {
    if #available(macOS 10.13, *) {
        let allowedClasses: [AnyClass] = [
            NSAttributedString.self,
            NSString.self,
            NSArray.self,
            NSDictionary.self,
            NSNumber.self,
            NSData.self,
            NSNull.self
        ]
        if let object = try? NSKeyedUnarchiver.unarchivedObject(ofClasses: allowedClasses, from: data),
           let text = foundationText(object) {
            return text
        }
    }
    guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: data) else {
        return nil
    }
    unarchiver.requiresSecureCoding = false
    defer { unarchiver.finishDecoding() }
    guard let object = unarchiver.decodeObject(forKey: NSKeyedArchiveRootObjectKey) else {
        return nil
    }
    return foundationText(object)
}

func looksLikeFoundationArchive(_ data: Data) -> Bool {
    data.starts(with: Data("bplist00".utf8))
}

func candidateScore(_ value: String) -> Int {
    let letters = value.unicodeScalars.filter { CharacterSet.letters.contains($0) }.count
    let digits = value.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) }.count
    let spaces = value.unicodeScalars.filter { CharacterSet.whitespaces.contains($0) }.count
    var score = (letters * 4) + (digits * 2) + spaces
    if value.range(of: "تم|خصم|إضافة|اضافة|تحويل|بطاقة|حساب|EGP|ج\\.?م", options: [.regularExpression, .caseInsensitive]) != nil {
        score += 30
    }
    return score
}

func decodeAttributedBody(_ data: Data) -> String? {
    if let archivedText = decodeFoundationText(data) {
        guard let candidate = cleanAttributedCandidate(archivedText), transactionLikeContent(candidate) else {
            return nil
        }
        return candidate
    }
    if looksLikeFoundationArchive(data) {
        return nil
    }

    let decoded = String(decoding: data, as: UTF8.self)
    let candidates = decoded.unicodeScalars
        .split(whereSeparator: { scalar in
            scalar.value < 0x20 || scalar.value == 0x7f || scalar.value == 0xfffd
        })
        .compactMap { cleanAttributedCandidate(String(String.UnicodeScalarView($0))) }
    return candidates
        .filter(transactionLikeContent)
        .max { left, right in
        let leftScore = candidateScore(left)
        let rightScore = candidateScore(right)
        if leftScore != rightScore { return leftScore < rightScore }
        if left.count != right.count { return left.count < right.count }
        return left < right
    }
}

func columnString(_ statement: OpaquePointer?, _ index: Int32) -> String {
    guard let value = sqlite3_column_text(statement, index) else { return "" }
    return String(cString: value)
}

func messageDate(for rawValue: Int64) -> Date? {
    guard rawValue > 0 else { return nil }
    let referenceSeconds = rawValue > 10_000_000_000 ? Double(rawValue) / 1_000_000_000 : Double(rawValue)
    guard referenceSeconds.isFinite, referenceSeconds >= 0, referenceSeconds <= 4_102_444_800 else {
        return nil
    }
    return Date(timeIntervalSinceReferenceDate: referenceSeconds)
}

func isoDate(for date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let line = String(data: data, encoding: .utf8) else {
        fail("Could not encode a Messages record as JSON")
    }
    print(line)
}

let options = parseOptions()
var database: OpaquePointer?
let openResult = sqlite3_open_v2(options.databasePath, &database, SQLITE_OPEN_READONLY, nil)
guard openResult == SQLITE_OK, let database else {
    fail("Messages database is not readable at " + options.databasePath)
}
defer { sqlite3_close(database) }

let forwardQuery = """
SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.date, h.id
FROM message AS m
JOIN handle AS h ON h.ROWID = m.handle_id
WHERE m.is_from_me = 0
  AND m.is_system_message = 0
  AND m.item_type = 0
  AND m.date > 0
  AND m.date <= 4102444800000000000
  AND (lower(h.id) LIKE '%alahly%' OR replace(replace(lower(h.id), ' ', ''), '-', '') = 'banquemisr')
  AND (m.date > ? OR (m.date = ? AND m.ROWID > ?))
ORDER BY m.date ASC, m.ROWID ASC
LIMIT ?;
"""

let newestQuery = """
SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.date, h.id
FROM message AS m
JOIN handle AS h ON h.ROWID = m.handle_id
WHERE m.is_from_me = 0
  AND m.is_system_message = 0
  AND m.item_type = 0
  AND m.date > 0
  AND m.date <= 4102444800000000000
  AND (lower(h.id) LIKE '%alahly%' OR replace(replace(lower(h.id), ' ', ''), '-', '') = 'banquemisr')
  AND (m.date < ? OR (m.date = ? AND m.ROWID < ?))
ORDER BY m.date DESC, m.ROWID DESC
LIMIT ?;
"""

let rawBatchLimit: Int32 = 500
var boundary = options.newest
    ? SourceCursor(dateNanoseconds: Int64.max, rowID: Int64.max)
    : options.afterCursor
var emittedCount = 0

while emittedCount < Int(options.limit) {
    var statement: OpaquePointer?
    let query = options.newest ? newestQuery : forwardQuery
    guard sqlite3_prepare_v2(database, query, -1, &statement, nil) == SQLITE_OK else {
        fail("Could not prepare the read-only Messages query")
    }

    sqlite3_bind_int64(statement, 1, boundary.dateNanoseconds)
    sqlite3_bind_int64(statement, 2, boundary.dateNanoseconds)
    sqlite3_bind_int64(statement, 3, boundary.rowID)
    sqlite3_bind_int(statement, 4, rawBatchLimit)

    var rowsRead = 0
    var lastRawCursor: SourceCursor?
    var stepResult = sqlite3_step(statement)
    while stepResult == SQLITE_ROW {
        rowsRead += 1
        let rowID = sqlite3_column_int64(statement, 0)
        let rawDate = sqlite3_column_int64(statement, 4)
        let rawCursor = SourceCursor(dateNanoseconds: rawDate, rowID: rowID)
        lastRawCursor = rawCursor

        if let date = messageDate(for: rawDate) {
            let guid = columnString(statement, 1)
            let text = columnString(statement, 2).trimmingCharacters(in: .whitespacesAndNewlines)
            let body: String
            if !text.isEmpty {
                body = text
            } else if let blob = sqlite3_column_blob(statement, 3) {
                let length = Int(sqlite3_column_bytes(statement, 3))
                body = decodeAttributedBody(Data(bytes: blob, count: length)) ?? ""
            } else {
                body = ""
            }

            let sender = columnString(statement, 5).trimmingCharacters(in: .whitespacesAndNewlines)
            if !guid.isEmpty, !body.isEmpty, !sender.isEmpty {
                emit([
                    "id": guid,
                    "sender": sender,
                    "receivedAt": isoDate(for: date),
                    "receivedAtNs": String(rawDate),
                    "cursor": cursorValue(dateNanoseconds: rawDate, rowID: rowID),
                    "body": body
                ])
                emittedCount += 1
                if emittedCount >= Int(options.limit) {
                    break
                }
            }
        }

        stepResult = sqlite3_step(statement)
    }
    sqlite3_finalize(statement)

    if emittedCount >= Int(options.limit) {
        break
    }
    guard stepResult == SQLITE_DONE else {
        fail("Could not read the read-only Messages query")
    }
    guard rowsRead > 0, let nextBoundary = lastRawCursor else {
        break
    }

    let progressed = options.newest
        ? (nextBoundary.dateNanoseconds < boundary.dateNanoseconds ||
            (nextBoundary.dateNanoseconds == boundary.dateNanoseconds && nextBoundary.rowID < boundary.rowID))
        : (nextBoundary.dateNanoseconds > boundary.dateNanoseconds ||
            (nextBoundary.dateNanoseconds == boundary.dateNanoseconds && nextBoundary.rowID > boundary.rowID))
    guard progressed else {
        fail("Messages query cursor did not advance")
    }
    boundary = nextBoundary
}
