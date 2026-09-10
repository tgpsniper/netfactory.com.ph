// ════════════════════════════════════════════════════════════
// LCP (Local Convergence Point) resolution
// ════════════════════════════════════════════════════════════
// An LCP has no row of its own in this deployment — it lives inside the NAP
// name: "APLT LCP18-N2", "DLYP-LCP1-NAP1", "LCP40-NAP3". 1266 of the 1267 NAPs
// carry it (only "DUM" does not), so parsing the name is the only way to
// resolve the OLT → PON → LCP → NAP → port chain for the data that exists.
//
// naps.lcp_nap_id / naps.is_lcp_port are the modelled link and always win when
// an operator has set them; this parser is the fallback, not the primary.
//
// The names carry real typos that the parser has to absorb — "SMN LCLP36-N4",
// "APLT LCFP14-N3", "LC[142-N3" — hence "LC" plus up to three non-digits
// rather than a literal "LCP".

// "APLT LCP18-N2" → { area: 'APLT', number: 18, name: 'APLT LCP18' }
function parseLcp(napName) {
  if (!napName) return null;
  const s = String(napName);
  const num = s.match(/LC[^0-9]{0,3}(\d+)/i);
  if (!num) return null;
  const area = s.match(/^\s*([A-Za-z]{2,6})[\s-]+LC/i);
  const a = area ? area[1].toUpperCase() : null;
  const n = Number(num[1]);
  return { area: a, number: n, name: (a ? a + ' ' : '') + 'LCP' + n };
}

// Postgres regex matching every NAP hanging off the same LCP. `area` only ever
// holds [A-Za-z] captured above, so it is safe to interpolate into the pattern.
function lcpSiblingRegex(lcp) {
  if (!lcp) return null;
  const head = lcp.area ? '^\\s*' + lcp.area + '[\\s-]+LC' : '^\\s*LC';
  return head + '[^0-9]{0,3}' + lcp.number + '([^0-9]|$)';
}

module.exports = { parseLcp, lcpSiblingRegex };
