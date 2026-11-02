/* === BAMBOCCHAN CARE: INVIO NOTIFICHE (Cloudflare Worker) ===
   Ogni minuto controlla su Firebase se c'è un promemoria da mandare e lo spedisce al telefono. */

const PROJECT_ID = 'bambocchan-app';
const MAX_DELAY_MS = 20 * 60 * 1000;   // se un promemoria è in ritardo di più di 20 minuti, non lo mando
const FAR_FUTURE = 9000000000000000;   // "nessun promemoria in programma"

/* --- Utilità per la firma (serve per ottenere il permesso da Google) --- */
function toBase64Url(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let text = '';
  bytes.forEach(function (byte) { text += String.fromCharCode(byte); });
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBuffer(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) { bytes[i] = raw.charCodeAt(i); }
  return bytes.buffer;
}

async function getAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = toBase64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(header + '.' + claims));
  const jwt = header + '.' + claims + '.' + toBase64Url(signature);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt
  });
  const result = await response.json();
  if (!result.access_token) { throw new Error('Token non ottenuto: ' + JSON.stringify(result)); }
  return result.access_token;
}

/* --- Conversione dal formato di Firestore a oggetti normali e ritorno --- */
function fromValue(value) {
  if ('stringValue' in value) { return value.stringValue; }
  if ('integerValue' in value) { return Number(value.integerValue); }
  if ('doubleValue' in value) { return value.doubleValue; }
  if ('booleanValue' in value) { return value.booleanValue; }
  if ('arrayValue' in value) { return (value.arrayValue.values || []).map(fromValue); }
  if ('mapValue' in value) {
    const result = {};
    const fields = value.mapValue.fields || {};
    Object.keys(fields).forEach(function (name) { result[name] = fromValue(fields[name]); });
    return result;
  }
  return null;
}

function toValue(value) {
  if (typeof value === 'number') { return { integerValue: String(Math.round(value)) }; }
  if (typeof value === 'string') { return { stringValue: value }; }
  if (Array.isArray(value)) { return { arrayValue: { values: value.map(toValue) } }; }
  const fields = {};
  Object.keys(value).forEach(function (name) { fields[name] = toValue(value[name]); });
  return { mapValue: { fields: fields } };
}

/* --- Invio di una notifica a un telefono --- */
async function sendNotification(accessToken, token, reminder) {
  const response = await fetch('https://fcm.googleapis.com/v1/projects/' + PROJECT_ID + '/messages:send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: token,
        data: { title: reminder.title, body: reminder.body, tag: reminder.tag || '' },
        webpush: { headers: { Urgency: 'high', TTL: '900' } }
      }
    })
  });

  if (response.ok) { return 'ok'; }
  if (response.status === 404 || response.status === 400) { return 'dead'; }  // telefono non più valido
  return 'error';
}

/* --- Lavoro che parte ogni minuto --- */
async function run(env) {
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const accessToken = await getAccessToken(account);
  const now = Date.now();
  const base = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

  // Prendo gli utenti che hanno almeno un promemoria scaduto
  const queryResponse = await fetch(base + ':runQuery', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: 'nextAt' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(now) } } },
        limit: 50
      }
    })
  });
  const rows = await queryResponse.json();
  if (!Array.isArray(rows)) { throw new Error('Query fallita: ' + JSON.stringify(rows)); }

  for (const row of rows) {
    if (!row.document) { continue; }

    const document = row.document;
    const reminders = fromValue({ arrayValue: document.fields.reminders ? document.fields.reminders.arrayValue : {} });
    const tokens = document.fields.tokens ? fromValue(document.fields.tokens) : [];

    const due = reminders.filter(function (item) { return item.at <= now; });
    const remaining = reminders.filter(function (item) { return item.at > now; });
    const toSend = due.filter(function (item) { return now - item.at <= MAX_DELAY_MS; });

    const aliveTokens = [];
    for (const token of tokens) {
      let isAlive = true;
      for (const reminder of toSend) {
        const result = await sendNotification(accessToken, token, reminder);
        if (result === 'dead') { isAlive = false; break; }
      }
      if (isAlive) { aliveTokens.push(token); }
    }

    // Aggiorno il documento: tolgo i promemoria già gestiti
    const lastSentAt = due.reduce(function (max, item) { return Math.max(max, item.at); }, 0);
    const update = {
      fields: {
        reminders: toValue(remaining),
        nextAt: toValue(remaining.length > 0 ? remaining[0].at : FAR_FUTURE),
        lastSentAt: toValue(lastSentAt),
        tokens: toValue(aliveTokens)
      }
    };

    const url = 'https://firestore.googleapis.com/v1/' + document.name +
      '?updateMask.fieldPaths=reminders&updateMask.fieldPaths=nextAt&updateMask.fieldPaths=lastSentAt&updateMask.fieldPaths=tokens' +
      '&currentDocument.updateTime=' + encodeURIComponent(document.updateTime);

    await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    });
  }
}

export default {
  // Parte da solo ogni minuto (lo imposti nei "Trigger" del Worker)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // Aprendo l'indirizzo del Worker nel browser vedi se è vivo (non manda nulla)
  async fetch() {
    return new Response('Bambocchan Care: invio notifiche attivo.');
  }
};
