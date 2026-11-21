// Fast drop-in for make.fun's csv-reader 1.0.0: returns exactly csv-reader's
// {columns, rows, errors} for every {text, header}, faster.
//
// Strategy: most records are a single line. One native regex scan finds the
// next quote or CR; a line with neither is split natively, a line with a
// quote is parsed quote-aware directly on the text (no per-line copy).
// Only the rare record — a quoted field spanning lines, a stray CR, junk
// after a closing quote, or a quote that never closes — falls back to a
// general parser that reproduces csv-reader 1.0.0's broken-row policy
// exactly.
//
// csv-reader 1.0.0 policy (reproduced exactly):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote; each CRLF or lone CR inside it reads as LF;
//   what follows its closing quote, up to the next comma or line break, is
//   appended as it stands (quote_junk, when the field ends); a quote that
//   never closes is a literal character and the text after it is read again
//   as unquoted (unterminated_quote). A quote inside an unquoted field is
//   a literal character. Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it, each padded with "" (short_row, with fields: its
//   field count) or cut (long_row, with extra: the cut fields) to the first
//   record's width. Each error is {code, line, row}, in the order met; line
//   is the 1-based line its record starts on (every LF, CRLF and lone CR
//   inside quotes counted), row its record's index in rows, null for the
//   header.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Next '"' or CR in the text (one native scan; lastIndex set per use).
const SPECIAL = /["\r]/g;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null for the header).
  let recordLine = 1;
  let recordRow = null;

  // True once proven: no quote or CR anywhere in the rest of the text,
  // so every remaining record is a clean line.
  let restClean = false;

  // Reads an unquoted field starting at pos, appending onto `value`.
  // Returns [value, ended, added]: ended is COMMA, LINE_BREAK or END;
  // added counts the characters kept (a dropped stray CR does not count).
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let end = -1;
      let ended = END;
      if (ci !== -1 && (ni === -1 || ci < ni)) {
        end = ci;
        ended = COMMA;
      } else if (ni !== -1) {
        end = ni;
        ended = LINE_BREAK;
      }
      if (end === -1) {
        const seg = text.slice(pos);
        const ri = seg.indexOf('\r');
        if (ri === -1) {
          value += seg;
          added += seg.length;
        } else {
          // Every CR here is stray (nothing follows but the end of text).
          let v = value;
          let s = 0;
          let k = -1;
          let kept = 0;
          while ((k = seg.indexOf('\r', s)) !== -1) {
            v += seg.slice(s, k);
            kept += k - s;
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            s = k + 1;
          }
          v += seg.slice(s);
          kept += seg.length - s;
          value = v;
          added += kept;
        }
        pos = len;
        return [value, END, added];
      }
      const seg = text.slice(pos, end);
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        value += seg;
        added += seg.length;
        pos = end + 1;
        if (ended === LINE_BREAK) line += 1;
        return [value, ended, added];
      }
      // One or more CRs inside the segment.
      let v = value;
      let s = 0;
      let k = -1;
      let kept = 0;
      while ((k = seg.indexOf('\r', s)) !== -1) {
        v += seg.slice(s, k);
        kept += k - s;
        if (k === seg.length - 1 && ended === LINE_BREAK) {
          // Trailing CR just before the LF: the CRLF line break, no error.
        } else {
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        }
        s = k + 1;
      }
      v += seg.slice(s);
      kept += seg.length - s;
      value = v;
      added += kept;
      pos = end + 1;
      if (ended === LINE_BREAK) line += 1;
      return [value, ended, added];
    }
  }

  // Finishes one parsed record: header, width, short/long row handling.
  // `quoted` says whether the record's last field opened with a quote
  // (a single empty unquoted field is no record; a quoted one is).
  function emit(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: one line. The regex finds the next quote or CR; a line
    // holding neither is one slice + split. A line with a quote is
    // parsed quote-aware straight on the text, bounded by fieldEnd; any
    // CR found inside a field, a quoted field that does not close on
    // this line, or junk after a closing quote bails (ok=false) to the
    // general parser below.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let fieldEnd = lineEnd;
    if (nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) fieldEnd = lineEnd - 1;
    let ok = true;
    let fields = null;
    let lastQuoted = false;
    let special = -1;
    if (!restClean) {
      SPECIAL.lastIndex = pos;
      const m = SPECIAL.exec(text);
      if (m === null) {
        restClean = true;
      } else {
        special = m.index;
      }
    }
    if (special === -1 || special >= fieldEnd) {
      fields = text.slice(pos, fieldEnd).split(',');
    } else if (text.charCodeAt(special) === 13) {
      ok = false; // stray CR in the line: general parser
    } else {
      const f = [];
      let i = pos;
      let q = false;
      outer: for (;;) {
        if (text.charCodeAt(i) === 34) {
          // Quoted field: find its closing quote on this line. The scan
          // itself reports whether any "" pair was skipped (hasDD).
          q = true;
          let close = -1;
          let s = i + 1;
          let hasDD = false;
          for (;;) {
            const qi = text.indexOf('"', s);
            if (qi === -1 || qi >= fieldEnd) {
              ok = false;
              break outer;
            }
            if (text.charCodeAt(qi + 1) === 34) {
              hasDD = true;
              s = qi + 2;
              continue;
            }
            close = qi;
            break;
          }
          let value = text.slice(i + 1, close);
          if (value.indexOf('\r') !== -1) {
            ok = false; // CR inside the quotes: general parser
            break outer;
          }
          if (hasDD) value = value.replaceAll('""', '"');
          const after = close + 1;
          if (after === fieldEnd) {
            f.push(value);
            break;
          }
          if (text.charCodeAt(after) === 44) {
            f.push(value);
            i = after + 1;
            q = false;
            continue;
          }
          ok = false; // junk after the closing quote: general parser
          break outer;
        }
        // Unquoted field: up to the next comma (a quote inside it is literal).
        q = false;
        const ci = text.indexOf(',', i);
        if (ci === -1 || ci >= fieldEnd) {
          const v = text.slice(i, fieldEnd);
          if (v.indexOf('\r') !== -1) {
            ok = false; // stray CR in the field: general parser
            break outer;
          }
          f.push(v);
          break;
        }
        const v = text.slice(i, ci);
        if (v.indexOf('\r') !== -1) {
          ok = false; // stray CR in the field: general parser
          break outer;
        }
        f.push(v);
        i = ci + 1;
      }
      if (ok) {
        fields = f;
        lastQuoted = q;
      }
    }
    if (ok) {
      // The line is never empty here (blank lines are skipped above), so
      // a single empty unquoted field cannot occur on this path.
      if (width >= 0 && fields.length === width && !(header && columns === null)) {
        rows.push(fields);
      } else {
        emit(fields, lastQuoted);
      }
      pos = nl === -1 ? len : nl + 1;
      line += 1;
      continue;
    }

    // Slow path: this record holds a stray CR, a quoted field spanning
    // lines, junk after a closing quote, or a quote that never closes.
    // Parsed field by field, exactly as csv-reader 1.0.0 does.
    fields = [];
    let quoted = false;
    let ended = COMMA;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (!quoted) {
        const r = readUnquoted('');
        fields.push(r[0]);
        ended = r[1];
        continue;
      }
      // Quoted field: find its closing quote (a quote not doubled).
      const open = pos;
      const openLine = line;
      let close = -1;
      let s = pos + 1;
      let hasDD = false;
      for (;;) {
        const qi = text.indexOf('"', s);
        if (qi === -1) break;
        if (text.charCodeAt(qi + 1) === 34) {
          hasDD = true;
          s = qi + 2;
          continue;
        }
        close = qi;
        break;
      }
      if (close === -1) {
        // The quote never closes: a literal character, the text after it
        // read again as unquoted.
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        pos = open + 1;
        line = openLine;
        const r = readUnquoted('"');
        fields.push(r[0]);
        ended = r[1];
        continue;
      }
      const seg = text.slice(open + 1, close);
      let value = seg;
      if (hasDD) value = value.replaceAll('""', '"');
      const hasCR = seg.indexOf('\r') !== -1;
      const hasLF = seg.indexOf('\n') !== -1;
      if (hasCR) value = value.replace(/\r\n?/g, '\n');
      if (hasCR || hasLF) {
        // Count the line breaks inside the quotes: each LF once, each
        // lone CR once (a CR before a LF is the one break of the CRLF).
        let n = 0;
        let i = -1;
        while ((i = seg.indexOf('\n', i + 1)) !== -1) n += 1;
        let j = -1;
        while ((j = seg.indexOf('\r', j + 1)) !== -1) {
          if (seg.charCodeAt(j + 1) !== 10) n += 1;
        }
        line += n;
      }
      pos = close + 1;
      if (pos >= len) {
        fields.push(value);
        ended = END;
        continue;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        fields.push(value);
        pos += 1;
        ended = COMMA;
      } else if (c === 10) {
        fields.push(value);
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        fields.push(value);
        pos += 2;
        line += 1;
        ended = LINE_BREAK;
      } else {
        // What follows the closing quote is appended as it stands.
        const r = readUnquoted(value);
        if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        fields.push(r[0]);
        ended = r[1];
      }
    } while (ended === COMMA);
    emit(fields, quoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
