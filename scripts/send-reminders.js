'use strict';
/* =====================================================================
   Blattwerk – tägliche Gieß-Erinnerungen per Push
   ---------------------------------------------------------------------
   Läuft jede volle Stunde über GitHub Actions (.github/workflows/giess-erinnerung.yml).
   Für jeden Nutzer mit eingeschalteten Erinnerungen:
     1. Ist in seiner Zeitzone gerade seine gewählte Uhrzeit? (sonst überspringen)
     2. Wurde heute schon erinnert? (dann überspringen – höchstens 1x pro Tag)
     3. Welche Pflanzen sind fällig? (letztes Gießdatum + Intervall ≤ heute)
     4. EINE zusammengefasste Nachricht an alle seine Geräte senden
     5. Tokens, die Firebase als ungültig meldet, aus Firestore löschen

   Anmeldung: Service-Account-JSON aus dem GitHub-Secret FIREBASE_SERVICE_ACCOUNT.
   Der Schlüssel steht NIE im Repository.
   Hinweis: Logs von öffentlichen Repositories sind öffentlich – darum werden
   hier keine Namen, Pflanzen oder Tokens ausgegeben, nur Zahlen.
   ===================================================================== */

const DEFAULT_TIME_ZONE = 'Europe/Berlin';
const DEFAULT_TIME = '08:00';
// GitHub startet geplante Läufe oft verspätet (oder lässt einen aus). Darum wird
// bis zu 2 Stunden nach der gewählten Uhrzeit nachgeholt – aber nur einmal pro Tag.
const CATCH_UP_HOURS = 2;
// Fehlercodes, bei denen ein Token dauerhaft unbrauchbar ist
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

// ---------- Datum (gleiche Logik wie in der App) ----------
const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function toUtc(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
function addDays(s, n) {
  const d = new Date(toUtc(s));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Datum und Stunde "jetzt" in einer Zeitzone
function localNow(timeZone, now = new Date()) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).forEach(p => { parts[p.type] = p.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// Fällige Pflanzen – dieselbe Rechnung wie in der App (daysUntilWater ≤ 0)
function duePlants(plants, today) {
  return plants
    .map(p => {
      const last = isYmd(p.lastWatered) ? p.lastWatered : today;
      const next = addDays(last, Number(p.intervalDays) || 7);
      const daysUntil = daysBetween(today, next);
      const every = Number(p.fertilizeEvery) || 0;
      const fertilize = every > 0 && (Number(p.waterCount) || 0) + 1 >= every;
      return { name: String(p.name || 'Pflanze').trim() || 'Pflanze', daysUntil, fertilize };
    })
    .filter(p => p.daysUntil <= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name, 'de'));
}

// "Monty", "Monty und Ficus", "Monty, Ficus und Kaktus", "Monty, Ficus und 2 weitere"
function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} und ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} und ${names[2]}`;
  return `${names[0]}, ${names[1]} und ${names.length - 2} weitere`;
}

// Text der zusammengefassten Nachricht
function buildText(due) {
  const title = '🌿 Zeit zum Gießen';
  let body;
  if (due.length === 1) {
    const p = due[0];
    const overdue = -p.daysUntil;
    body = `${p.name} braucht heute Wasser`;
    if (overdue > 0) body += ` (seit ${overdue} ${overdue === 1 ? 'Tag' : 'Tagen'} fällig)`;
    if (p.fertilize) body += ' – diesmal mit Dünger 🧪';
  } else {
    body = `${listNames(due.map(p => p.name))} brauchen Wasser`;
    const fert = due.filter(p => p.fertilize).map(p => p.name);
    if (fert.length === 1) body += ` · 🧪 ${fert[0]} diesmal mit Dünger`;
    else if (fert.length === 2) body += ` · 🧪 ${fert[0]} und ${fert[1]} diesmal mit Dünger`;
    else if (fert.length > 2) body += ` · 🧪 ${fert.length} davon diesmal mit Dünger`;
  }
  return { title, body };
}

// Adresse der App (für Icon und Klick auf die Nachricht)
function resolveAppUrl(env = process.env) {
  if (env.APP_URL) return env.APP_URL.endsWith('/') ? env.APP_URL : env.APP_URL + '/';
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('APP_URL fehlt (z. B. https://name.github.io/blattwerk/).');
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}

// Nachricht für alle Geräte eines Nutzers (Web-Push, damit iOS sie zuverlässig anzeigt)
function buildMessage(tokens, { title, body }, appUrl) {
  return {
    tokens,
    webpush: {
      headers: { Urgency: 'high', TTL: String(12 * 60 * 60) },   // 12 Stunden zustellbar
      notification: {
        title,
        body,
        icon: appUrl + 'icons/icon-192.png',
        badge: appUrl + 'icons/icon-192.png',
        tag: 'giess-erinnerung'
      },
      fcmOptions: { link: appUrl }
    }
  };
}

// Einen Nutzer prüfen und ggf. benachrichtigen. Gibt das Ergebnis als Stichwort zurück.
async function processUser(userSnap, { messaging, now, testMode, appUrl, stats }) {
  const u = userSnap.data() || {};
  const tz = isValidTimeZone(u.timeZone) ? u.timeZone : DEFAULT_TIME_ZONE;
  const time = /^\d{2}:\d{2}$/.test(u.reminderTime || '') ? u.reminderTime : DEFAULT_TIME;
  const local = localNow(tz, now);

  if (!testMode) {
    const diff = local.hour - Number(time.slice(0, 2));
    if (diff < 0 || diff > CATCH_UP_HOURS) return 'not-time';
    if (u.lastReminderDate === local.date) return 'already';
  }

  // Nur die nötigen Felder laden (die Fotos werden nicht gebraucht)
  const plantsSnap = await userSnap.ref.collection('plants')
    .select('name', 'lastWatered', 'intervalDays', 'fertilizeEvery', 'waterCount').get();
  const due = duePlants(plantsSnap.docs.map(d => d.data()), local.date);
  if (!due.length) return 'nothing-due';

  const devicesSnap = await userSnap.ref.collection('devices').get();
  const devices = devicesSnap.docs
    .map(d => ({ ref: d.ref, token: (d.data() || {}).token || d.id }))
    .filter(d => d.token);
  if (!devices.length) return 'no-devices';

  const result = await messaging.sendEachForMulticast(
    buildMessage(devices.map(d => d.token), buildText(due), appUrl));

  let delivered = 0;
  const invalid = [];
  result.responses.forEach((r, i) => {
    if (r.success) { delivered++; return; }
    const code = r.error && r.error.code;
    if (INVALID_TOKEN_CODES.has(code)) invalid.push(devices[i].ref);
    else console.warn(`  ⚠ Gerät nicht erreicht (${code || 'unbekannter Fehler'})`);
  });
  if (invalid.length) {
    await Promise.all(invalid.map(ref => ref.delete()));
    stats.tokensRemoved += invalid.length;
  }
  stats.devicesReached += delivered;
  stats.devicesFailed += result.responses.length - delivered;
  if (!delivered) return 'send-failed';

  // Merken, dass heute erinnert wurde (nicht bei Testläufen)
  if (!testMode) await userSnap.ref.update({ lastReminderDate: local.date });
  return 'sent';
}

async function sendReminders({ db, messaging, now = new Date(), testMode = false, appUrl }) {
  const stats = {
    users: 0, sent: 0, notTime: 0, already: 0, nothingDue: 0, noDevices: 0,
    sendFailed: 0, errors: 0, devicesReached: 0, devicesFailed: 0, tokensRemoved: 0
  };
  const keyFor = { 'sent': 'sent', 'not-time': 'notTime', 'already': 'already', 'nothing-due': 'nothingDue', 'no-devices': 'noDevices', 'send-failed': 'sendFailed' };

  console.log(`Blattwerk-Erinnerungen · ${now.toISOString()}${testMode ? ' · TESTLAUF (Uhrzeit und Tageslimit werden ignoriert)' : ''}`);
  const usersSnap = await db.collection('users').where('remindersEnabled', '==', true).get();
  for (const userSnap of usersSnap.docs) {
    stats.users++;
    try {
      const outcome = await processUser(userSnap, { messaging, now, testMode, appUrl, stats });
      stats[keyFor[outcome]]++;
    } catch (err) {
      stats.errors++;
      console.error(`  ✖ Fehler bei einem Nutzer: ${err.message}`);
    }
  }

  console.log('');
  console.log(`Nutzer mit Erinnerungen geprüft: ${stats.users}`);
  console.log(`  Nachricht gesendet:            ${stats.sent} (an ${stats.devicesReached} Gerät(e))`);
  console.log(`  noch nicht ihre Uhrzeit:       ${stats.notTime}`);
  console.log(`  heute schon erinnert:          ${stats.already}`);
  console.log(`  nichts fällig:                 ${stats.nothingDue}`);
  console.log(`  kein Gerät gespeichert:        ${stats.noDevices}`);
  console.log(`  Versand fehlgeschlagen:        ${stats.sendFailed}`);
  console.log(`  Fehler:                        ${stats.errors}`);
  console.log(`Ungültige Tokens gelöscht:       ${stats.tokensRemoved}`);
  return stats;
}

// ---------- Start (nur wenn direkt mit "node send-reminders.js" aufgerufen) ----------
async function run() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Secret FIREBASE_SERVICE_ACCOUNT fehlt (GitHub → Settings → Secrets and variables → Actions).');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT ist kein gültiges JSON.'); }

  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getMessaging } = require('firebase-admin/messaging');
  initializeApp({ credential: cert(serviceAccount) });

  const stats = await sendReminders({
    db: getFirestore(),
    messaging: getMessaging(),
    testMode: process.env.TEST_MODE === 'true',
    appUrl: resolveAppUrl()
  });
  if (stats.errors) process.exitCode = 1;
}

if (require.main === module) {
  run().catch(err => {
    console.error('Abbruch: ' + err.message);
    process.exit(1);
  });
}

module.exports = { duePlants, buildText, buildMessage, localNow, resolveAppUrl, sendReminders };
