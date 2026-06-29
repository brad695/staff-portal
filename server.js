const http  = require('http');
const https = require('https');
const fs    = require('fs');
const url   = require('url');
// ════════════════════════════════════════════
//   YOUR CREDENTIALS
// ════════════════════════════════════════════
const API_KEY    = process.env.API_KEY;
const SITE_ID    = process.env.SITE_ID;
const NOTES_PASS = process.env.NOTES_PASS;
const SHEET_URL  = process.env.SHEET_URL;
// ════════════════════════════════════════════
const PORT = 3000;
function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => cb(body));
}
function loadEvents() {
  try {
    return JSON.parse(fs.readFileSync(__dirname + '/events.json', 'utf8'));
  } catch(e) { return []; }
}
function saveEventsFile(events) {
  fs.writeFileSync(__dirname + '/events.json', JSON.stringify(events, null, 2));
}function loadSchedules() {
  try {
    return JSON.parse(fs.readFileSync(__dirname + '/scheduling.json', 'utf8'));
  } catch(e) { return []; }
}
function saveSchedulesFile(schedules) {
  fs.writeFileSync(__dirname + '/scheduling.json', JSON.stringify(schedules, null, 2));
}
function loadTimeOff() {
  try {
    return JSON.parse(fs.readFileSync(__dirname + '/time-off.json', 'utf8'));
  } catch(e) { return []; }
}
function saveTimeOffFile(requests) {
  fs.writeFileSync(__dirname + '/time-off.json', JSON.stringify(requests, null, 2));
}

function fetchCSV(targetUrl, cb, hops) {
  hops = hops || 0;
  if (hops > 8) { cb(new Error('Too many redirects')); return; }
  const mod = targetUrl.startsWith('https') ? https : require('http');
  mod.get(targetUrl, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      fetchCSV(res.headers.location, cb, hops + 1);
    } else {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Google sometimes returns an HTML redirect page — extract the real URL
        if (data.trim().startsWith('<') && data.includes('HREF=')) {
          const match = data.match(/HREF="([^"]*output=csv[^"]*)"/i);
          if (match) { fetchCSV(match[1], cb, hops + 1); return; }
        }
        cb(null, data);
      });
    }
  }).on('error', (e) => cb(e));
}
function parseDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = parseInt(m[3]);
    if (year < 100) year += 2000;
    return year + '-' + String(m[1]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0');
  }
  return str;
}
function parseTime(str) {
  if (!str) return '';
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1]);
    const min = m[2];
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return String(h).padStart(2,'0') + ':' + min;
  }
  return str;
}
http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    fs.readFile(__dirname + '/index.html', (err, data) => {
      if (err) { res.writeHead(500); res.end('Could not load index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (parsed.pathname === '/api/notes' && req.method === 'GET') {
    fs.readFile(__dirname + '/notes.json', 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(err ? JSON.stringify({ note: '' }) : data);
    });
    return;
  }
  if (parsed.pathname === '/api/notes' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (payload.password !== NOTES_PASS) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Wrong password' }));
          return;
        }
        fs.writeFile(__dirname + '/notes.json', JSON.stringify({ note: payload.note || '' }, null, 2), (err) => {
          if (err) { res.writeHead(500); res.end(JSON.stringify({ error: 'Could not save' })); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  if (parsed.pathname === '/api/notes/verify' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (payload.password === NOTES_PASS) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Wrong password' }));
        }
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  if (parsed.pathname === '/api/sync-sheet' && req.method === 'POST') {
    if (!SHEET_URL) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SHEET_URL not configured.' }));
      return;
    }
    fetchCSV(SHEET_URL, (err, csv) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not fetch sheet: ' + err.message }));
        return;
      }
      try {
        console.log('[SYNC] Raw CSV (first 500):', JSON.stringify(csv.substring(0,500)));
        const allLines = csv.trim().split('\n');
        console.log('[SYNC] Total lines:', allLines.length);
        const firstCell = allLines[0].split(',')[0].replace(/"/g,'').trim().toLowerCase();
        console.log('[SYNC] First cell:', JSON.stringify(firstCell));
        const lines = firstCell === 'type' ? allLines.slice(1) : allLines;
        console.log('[SYNC] Parsing', lines.length, 'lines');
        let notes = null, specials = null;
        const events = [];
        const schedules = [];
        for (const line of lines) {
          const cols = [];
          let cur = '', inQ = false;
          for (const ch of line.replace(/\r/g,'')) {
            if (ch === '"') { inQ = !inQ; }
            else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
            else cur += ch;
          }
          cols.push(cur);
          const clean = cols.map(c => c.replace(/^"|"$/g,'').trim());
          const [type, content, datestart, dateend, time, description] = clean;
          console.log('[SYNC] Row:', JSON.stringify(clean.slice(0,5)));
          if (!type) continue;
          const t = type.toLowerCase();
          if (t === 'notes' || t === 'note') notes = content || '';
          else if (t === 'specials' || t === 'special') {
            specials = (specials ? specials + '\n' : '') + (content || '') + (description ? ' — ' + description : '');
          }
          else if (t === 'event' && content && datestart) {
            events.push({ id: Date.now() + events.length, name: content, date: parseDate(datestart), endDate: parseDate(dateend||''), time: parseTime(time||''), desc: description||'' });
          }
          if (type === 'schedule') { schedules.push({ id: Date.now() + schedules.length, name: content, date: parseDate(datestart), endDate: parseDate(dateend||''), note: description||'' }); }
        }
        if (notes !== null) fs.writeFileSync(__dirname + '/notes.json', JSON.stringify({ note: notes }, null, 2));
        if (specials !== null) fs.writeFileSync(__dirname + '/specials.json', JSON.stringify({ specials }, null, 2));
        events.sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
        if (events.length) saveEventsFile(events);
        schedules.sort(function(a,b){return (a.date||'').localeCompare(b.date||'');});
        saveSchedulesFile(schedules);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, notes: notes !== null, specials: specials !== null, events: events.length }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse: ' + e.message }));
      }
    });
    return;
  }
  if (parsed.pathname === '/api/specials' && req.method === 'GET') {
    fs.readFile(__dirname + '/specials.json', 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(err ? JSON.stringify({ specials: '' }) : data);
    });
    return;
  }
  if (parsed.pathname === '/api/specials' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (payload.password !== NOTES_PASS) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Wrong password' }));
          return;
        }
        fs.writeFile(__dirname + '/specials.json', JSON.stringify({ specials: payload.specials || '' }, null, 2), (err) => {
          if (err) { res.writeHead(500); res.end(JSON.stringify({ error: 'Could not save' })); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  if (parsed.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadEvents()));
    return;
  }
  if (parsed.pathname === '/api/events' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (!payload.name || !payload.date) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'name and date required' })); return;
        }
        const events = loadEvents();
        events.push({ id: Date.now(), name: payload.name, date: payload.date, time: payload.time||'', desc: payload.desc||'' });
        events.sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
        saveEventsFile(events);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  const deleteMatch = parsed.pathname.match(/^\/api\/events\/(\d+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = parseInt(deleteMatch[1], 10);
    const events = loadEvents().filter(e => e.id !== id);
    saveEventsFile(events);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
    return;
  }
  if (parsed.pathname === '/api/scheduling' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadSchedules()));
    return;
  }
  if (parsed.pathname === '/api/scheduling' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (!payload.name || !payload.date) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'name and date required' })); return;
        }
        const schedules = loadSchedules();
        schedules.push({ id: Date.now(), name: payload.name, date: payload.date, endDate: payload.endDate || '', note: payload.note || '' });
        schedules.sort((a,b) => a.date.localeCompare(b.date));
        saveSchedulesFile(schedules);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(schedules));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  const schedDeleteMatch = parsed.pathname.match(/^\/api\/scheduling\/(\d+)$/);
  if (schedDeleteMatch && req.method === 'DELETE') {
    const id = parseInt(schedDeleteMatch[1], 10);
    const schedules = loadSchedules().filter(s => s.id !== id);
    saveSchedulesFile(schedules);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(schedules));
    return;
  }
  // ── TIME-OFF REQUESTS ────────────────────────────────────
  if (parsed.pathname === '/api/time-off' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadTimeOff()));
    return;
  }
  if (parsed.pathname === '/api/time-off' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (!payload.name || !payload.startDate) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'name and startDate required' })); return;
        }
        const requests = loadTimeOff();
        requests.push({
          id: Date.now(),
          name: payload.name.trim(),
          startDate: payload.startDate,
          endDate: payload.endDate || '',
          reason: (payload.reason || '').trim(),
          status: 'pending',
          submittedAt: new Date().toISOString()
        });
        requests.sort((a, b) => a.startDate.localeCompare(b.startDate));
        saveTimeOffFile(requests);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requests));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  const timeOffMatch = parsed.pathname.match(/^\/api\/time-off\/(\d+)$/);
  if (timeOffMatch && req.method === 'PATCH') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (payload.password !== NOTES_PASS) {
          res.writeHead(403); res.end(JSON.stringify({ error: 'Wrong password' })); return;
        }
        const id = parseInt(timeOffMatch[1], 10);
        const requests = loadTimeOff();
        const req2 = requests.find(r => r.id === id);
        if (!req2) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
        if (payload.status) req2.status = payload.status;
        saveTimeOffFile(requests);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requests));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  if (timeOffMatch && req.method === 'DELETE') {
    readBody(req, (body) => {
      try {
        const payload = JSON.parse(body);
        if (payload.password !== NOTES_PASS) {
          res.writeHead(403); res.end(JSON.stringify({ error: 'Wrong password' })); return;
        }
        const id = parseInt(timeOffMatch[1], 10);
        const requests = loadTimeOff().filter(r => r.id !== id);
        saveTimeOffFile(requests);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requests));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }
  if (parsed.pathname === '/api/reservations' && req.method === 'GET') {
    const queryParams = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed.query)) queryParams.set(k, v);
    queryParams.set('fieldsets', 'FULL');
    const wixUrl = `https://www.wixapis.com/table-reservations/reservations/v1/reservations?${queryParams.toString()}`;
    console.log(`[${new Date().toLocaleTimeString()}] Fetching: ${wixUrl}`);
    const proxyReq = https.request(wixUrl, {
      method: 'GET',
      headers: { 'Authorization': API_KEY, 'wix-site-id': SITE_ID, 'Content-Type': 'application/json' }
    }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        console.log(`[${new Date().toLocaleTimeString()}] Wix responded: HTTP ${proxyRes.statusCode}`);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(body);
      });
    });
    proxyReq.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxyReq.end();
    return;
  }
  // ── EZCATER ORDERS ──────────────────────────────────────
const EZCATER_COOKIE = process.env.EZCATER_COOKIE;  // add to your .env

if (parsed.pathname === '/api/ezcater-orders' && req.method === 'GET') {
  if (!EZCATER_COOKIE) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'EZCATER_COOKIE not configured.' }));
    return;
  }

  const gqlBody = JSON.stringify({
    query: `query GetUpcomingOrders($catId: ID!) {
      catererAccount(id: $catId) {
        orders(filter: UPCOMING, limit: 50) {
          edges {
            node {
              id
              formattedOrderNumber
              orderSourceType
              submittedAt
              event {
                timestamp
                deliveryTime
                timeZoneIdentifier
                orderType
                address { street city state zip }
              }
              catererWorkflowState { state }
              catererCart {
                totals { catererTotal }
              }
              orderCustomer { name }
            }
          }
        }
      }
    }`,
    variables: { catId: process.env.EZCATER_CATERER_ID }
  });

  const options = {
    hostname: 'federation-gateway.ezcater.com',
    path: '/graphql',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(gqlBody),
      'Cookie': EZCATER_COOKIE,
      'Origin': 'https://ezmanage.ezcater.com',
      'Referer': 'https://ezmanage.ezcater.com/'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
  });
  proxyReq.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
  proxyReq.write(gqlBody);
  proxyReq.end();
  return;
}
  res.writeHead(404);
  res.end('Not found');
}).listen(PORT, () => {
  console.log('\n  ✅  Reservations Viewer is running!');
  console.log(`  👉  Open this in your browser: http://localhost:${PORT}\n`);
});
