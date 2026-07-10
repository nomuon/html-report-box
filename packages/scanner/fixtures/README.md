# Scanner golden-test fixtures

- `malicious/` — INTENTIONALLY hostile HTML samples (phishing forms,
  `eval(atob(...))` droppers, miners, hidden iframes, ...). They exist so the
  scanner's block rules are regression-tested. Never open them from a served
  origin; never "fix" the security issues in them.
- `warn/` — samples that must be held for admin review (verdict `warn`).
- `benign/` — Claude-generated-style reports (CDN-loaded Chart.js/Tailwind,
  Japanese dashboards, static SVG). The scanner must produce ZERO findings on
  every file here; any finding is a false-positive regression. SRI attributes
  are deliberately absent because real Claude output