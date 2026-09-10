#!/usr/bin/env bash
# Source this to export PG* vars parsed from the API's DATABASE_URL.
# Uses discrete PGHOST/PGUSER/PGPASSWORD so special chars in the password
# don't break libpq's URL parser (which `psql "$DATABASE_URL"` trips over).
eval "$(node -e '
const fs=require("fs");
const m=fs.readFileSync(".env","utf8").match(/DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
if(!m){process.stderr.write("no DATABASE_URL in .env\n");process.exit(1);}
const u=new URL(m[1]);
const host=(u.hostname==="localhost")?"127.0.0.1":u.hostname;   // force TCP
const q=s=>"\x27"+String(s).replace(/\x27/g,"\x27\\\x27\x27")+"\x27";
console.log("export PGHOST="+q(host)+" PGPORT="+q(u.port||"5432")+
            " PGUSER="+q(decodeURIComponent(u.username))+
            " PGPASSWORD="+q(decodeURIComponent(u.password))+
            " PGDATABASE="+q(u.pathname.replace(/^\//,"")));
')"
