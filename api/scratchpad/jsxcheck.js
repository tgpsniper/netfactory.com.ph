// Extract the in-browser-transpiled JSX block from the CRM page and parse it,
// so a syntax error is caught here instead of as a blank page in the browser.
const fs = require('fs');
const babel = require('/home/ashraf/.cache/typescript/6.0/node_modules/@babel/parser');
const html = fs.readFileSync(process.argv[2], 'utf8');
const m = html.match(/<script type="text\/jsx-source" id="jsx-source">([\s\S]*?)<\/script>/);
if (!m) { console.error('jsx-source block not found'); process.exit(2); }
try {
  babel.parse(m[1], { sourceType: 'script', plugins: ['jsx'] });
  console.log('JSX OK —', m[1].split('\n').length, 'lines');
} catch (e) {
  console.error('JSX ERROR:', e.message);
  const line = (e.loc && e.loc.line) || 0;
  const src = m[1].split('\n');
  for (let i = Math.max(0, line - 4); i < Math.min(src.length, line + 3); i++) {
    console.error(`${i === line - 1 ? '>>' : '  '} ${i + 1}: ${src[i].slice(0, 200)}`);
  }
  process.exit(1);
}
