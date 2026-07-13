// Serveur complet : sert les pages du site (formulaire école + vue cuisine),
// enregistre les commandes, et envoie les emails de confirmation via Brevo.
//
// Rien à modifier ici pour l'usage courant : les réglages (clé Brevo, email
// d'expéditeur) se font via les variables d'environnement dans Render.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA_FILE = path.join(__dirname, "orders-data.json");

const JOURS = [
  { id: "lundi", label: "Lundi" },
  { id: "mardi", label: "Mardi" },
  { id: "jeudi", label: "Jeudi" },
  { id: "vendredi", label: "Vendredi" },
];

// ---------- Stockage (fichier JSON local) ----------
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.corrections) parsed.corrections = [];
    return parsed;
  } catch (e) {
    return { schools: {}, orders: {}, corrections: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Reconstitue le lundi (UTC) d'une semaine ISO à partir de sa clé "YYYY-Sww".
function mondayFromWeekKey(weekKey) {
  const [yearStr, weekStr] = weekKey.split("-S");
  const year = parseInt(yearStr, 10);
  const week = parseInt(weekStr, 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

const DAY_OFFSET = { lundi: 0, mardi: 1, jeudi: 3, vendredi: 4 };

function dateForDay(weekKey, dayId) {
  const monday = mondayFromWeekKey(weekKey);
  const d = new Date(monday);
  d.setUTCDate(monday.getUTCDate() + (DAY_OFFSET[dayId] || 0));
  return d;
}

function monthKeyFor(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

// Heure actuelle à Bruxelles (gère automatiquement l'heure d'été/hiver).
function brusselsNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Brussels",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: dayMap[map.weekday], hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10) };
}

function isCorrectionWindowOpen() {
  const { weekday, hour, minute } = brusselsNow();
  const schoolDays = [1, 2, 4, 5];
  if (!schoolDays.includes(weekday)) return false;
  return hour < 9 || (hour === 9 && minute <= 15);
}

function todayDayId() {
  const { weekday } = brusselsNow();
  const map = { 1: "lundi", 2: "mardi", 4: "jeudi", 5: "vendredi" };
  return map[weekday] || null;
}

function getISOWeekKeyForDate(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-S${String(weekNo).padStart(2, "0")}`;
}

// ---------- Envoi d'email via Brevo ----------
async function sendConfirmationEmail({ schoolEmail, schoolName, weekLabel, week, comment }) {
  const lignes = JOURS.map((j) => {
    const d = week[j.id] || {};
    return `<tr>
      <td style="padding:6px 10px;border:1px solid #ddd">${j.label}</td>
      <td style="padding:6px 10px;border:1px solid #ddd">${d.soupe || 0} L</td>
      <td style="padding:6px 10px;border:1px solid #ddd">${d.maternelle || 0}</td>
      <td style="padding:6px 10px;border:1px solid #ddd">${d.primaire || 0}</td>
      <td style="padding:6px 10px;border:1px solid #ddd">${d.primairePlus || 0}</td>
    </tr>`;
  }).join("");

  const html = `
    <p>Bonjour,</p>
    <p>Voici la confirmation de votre commande pour la semaine du <strong>${weekLabel}</strong> :</p>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr style="background:#f2efe5">
        <th style="padding:6px 10px;border:1px solid #ddd">Jour</th>
        <th style="padding:6px 10px;border:1px solid #ddd">Soupe</th>
        <th style="padding:6px 10px;border:1px solid #ddd">Maternelle</th>
        <th style="padding:6px 10px;border:1px solid #ddd">Primaire</th>
        <th style="padding:6px 10px;border:1px solid #ddd">Primaire +</th>
      </tr>
      ${lignes}
    </table>
    ${comment ? `<p><strong>Commentaire :</strong> ${comment}</p>` : ""}
    <p>Merci de votre commande.</p>
  `;

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        name: process.env.SENDER_NAME || "Restaurant",
        email: process.env.SENDER_EMAIL,
      },
      to: [{ email: schoolEmail, name: schoolName }],
      subject: `Confirmation de commande - ${schoolName} - semaine du ${weekLabel}`,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Brevo a refusé l'envoi : ${errText}`);
  }
  return res.json();
}

async function sendCorrectionEmail({ schoolEmail, schoolName, dayLabel, delta, newValues }) {
  const fmtDelta = (v) => (v > 0 ? `+${v}` : `${v}`);
  const html = `
    <p>Bonjour,</p>
    <p>Une rectification a été prise en compte pour <strong>${dayLabel}</strong> :</p>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr style="background:#f2efe5">
        <th style="padding:6px 10px;border:1px solid #ddd"></th>
        <th style="padding:6px 10px;border:1px solid #ddd">Soupe</th>
        <th style="padding:6px 10px;border:1px solid #ddd">Maternelle</th>
        <th style="padding:6px 10px;border:1px solid #ddd">Primaire</th>
        <th style="padding:6px 10px;border:1px solid #ddd">Primaire +</th>
      </tr>
      <tr>
        <td style="padding:6px 10px;border:1px solid #ddd">Rectification</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${fmtDelta(delta.soupe)}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${fmtDelta(delta.maternelle)}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${fmtDelta(delta.primaire)}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${fmtDelta(delta.primairePlus)}</td>
      </tr>
      <tr>
        <td style="padding:6px 10px;border:1px solid #ddd"><strong>Nouveau total du jour</strong></td>
        <td style="padding:6px 10px;border:1px solid #ddd">${newValues.soupe} L</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${newValues.maternelle}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${newValues.primaire}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${newValues.primairePlus}</td>
      </tr>
    </table>
    <p>Merci.</p>
  `;

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        name: process.env.SENDER_NAME || "Restaurant",
        email: process.env.SENDER_EMAIL,
      },
      to: [{ email: schoolEmail, name: schoolName }],
      subject: `Rectification de commande - ${schoolName} - ${dayLabel}`,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Brevo a refusé l'envoi : ${errText}`);
  }
  return res.json();
}

// ---------- API ----------

// Vérifie ou crée le code d'accès d'une école.
app.post("/api/access", (req, res) => {
  const { schoolName, code } = req.body || {};
  if (!schoolName || !code) {
    return res.status(400).json({ ok: false, error: "Nom d'école et code requis." });
  }
  const nameLower = schoolName.trim().toLowerCase();
  const data = loadData();
  const hash = hashCode(code);

  if (data.schools[nameLower]) {
    if (data.schools[nameLower].codeHash !== hash) {
      return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
    }
  } else {
    data.schools[nameLower] = { schoolName: schoolName.trim(), codeHash: hash };
    saveData(data);
  }
  res.json({ ok: true });
});

// Enregistre une commande et envoie l'email de confirmation.
app.post("/api/orders", async (req, res) => {
  const { schoolName, schoolEmail, code, weekKey, weekLabel, week, comment } = req.body || {};
  if (!schoolName || !schoolEmail || !code || !weekKey || !week) {
    return res.status(400).json({ ok: false, error: "Informations manquantes." });
  }
  const nameLower = schoolName.trim().toLowerCase();
  const data = loadData();
  const hash = hashCode(code);

  if (data.schools[nameLower] && data.schools[nameLower].codeHash !== hash) {
    return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
  }
  if (!data.schools[nameLower]) {
    data.schools[nameLower] = { schoolName: schoolName.trim(), codeHash: hash };
  }

  if (!data.orders[weekKey]) data.orders[weekKey] = {};
  data.orders[weekKey][nameLower] = {
    schoolName: schoolName.trim(),
    schoolEmail: schoolEmail.trim(),
    week,
    comment: comment || "",
    submittedAt: new Date().toISOString(),
  };
  saveData(data);

  let emailSent = false;
  let emailError = null;
  try {
    await sendConfirmationEmail({ schoolEmail: schoolEmail.trim(), schoolName: schoolName.trim(), weekLabel, week, comment });
    emailSent = true;
  } catch (e) {
    emailError = e.message;
  }

  res.json({ ok: true, emailSent, emailError });
});

// Renvoie la commande de l'école pour une semaine donnée (pour afficher le jour à rectifier).
app.post("/api/orders/mine", (req, res) => {
  const { schoolName, code, weekKey } = req.body || {};
  if (!schoolName || !code || !weekKey) {
    return res.status(400).json({ ok: false, error: "Informations manquantes." });
  }
  const nameLower = schoolName.trim().toLowerCase();
  const data = loadData();
  const hash = hashCode(code);

  if (!data.schools[nameLower] || data.schools[nameLower].codeHash !== hash) {
    return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
  }

  const order = (data.orders[weekKey] || {})[nameLower] || null;
  res.json({
    ok: true,
    order,
    correctionOpen: isCorrectionWindowOpen(),
    todayDayId: todayDayId(),
    currentWeekKey: getISOWeekKeyForDate(new Date()),
  });
});

// Applique une rectification (+/-) sur le jour même, avant 9h15.
app.post("/api/orders/correction", async (req, res) => {
  const { schoolName, code, dayId, delta } = req.body || {};
  if (!schoolName || !code || !dayId || !delta) {
    return res.status(400).json({ ok: false, error: "Informations manquantes." });
  }
  if (!isCorrectionWindowOpen()) {
    return res.status(403).json({ ok: false, error: "La fenêtre de rectification (avant 9h15) est fermée pour aujourd'hui." });
  }
  if (todayDayId() !== dayId) {
    return res.status(403).json({ ok: false, error: "La rectification ne concerne que la journée en cours." });
  }

  const nameLower = schoolName.trim().toLowerCase();
  const data = loadData();
  const hash = hashCode(code);

  if (!data.schools[nameLower] || data.schools[nameLower].codeHash !== hash) {
    return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
  }

  const weekKey = getISOWeekKeyForDate(new Date());
  const order = (data.orders[weekKey] || {})[nameLower];
  if (!order) {
    return res.status(404).json({ ok: false, error: "Aucune commande trouvée pour cette semaine." });
  }

  const dayValues = order.week[dayId] || { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 };
  const newValues = {
    soupe: Math.max(0, Number(dayValues.soupe || 0) + Number(delta.soupe || 0)),
    maternelle: Math.max(0, Number(dayValues.maternelle || 0) + Number(delta.maternelle || 0)),
    primaire: Math.max(0, Number(dayValues.primaire || 0) + Number(delta.primaire || 0)),
    primairePlus: Math.max(0, Number(dayValues.primairePlus || 0) + Number(delta.primairePlus || 0)),
  };
  order.week[dayId] = newValues;
  data.corrections.push({
    timestamp: new Date().toISOString(),
    schoolName: order.schoolName,
    weekKey,
    dayId,
    delta,
    newValues,
  });
  saveData(data);

  const dayLabel = JOURS.find((j) => j.id === dayId)?.label || dayId;
  let emailSent = false;
  let emailError = null;
  try {
    await sendCorrectionEmail({ schoolEmail: order.schoolEmail, schoolName: order.schoolName, dayLabel, delta, newValues });
    emailSent = true;
  } catch (e) {
    emailError = e.message;
  }

  res.json({ ok: true, newValues, emailSent, emailError });
});

// Liste les mois pour lesquels des commandes existent (pour le sélecteur).
app.get("/api/billing/months", (req, res) => {
  const { code } = req.query;
  if (!process.env.KITCHEN_CODE || code !== process.env.KITCHEN_CODE) {
    return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
  }
  const data = loadData();
  const months = new Set();
  Object.entries(data.orders).forEach(([weekKey, schools]) => {
    Object.values(schools).forEach((order) => {
      JOURS.forEach((j) => {
        const val = order.week[j.id];
        if (val && (val.soupe || val.maternelle || val.primaire || val.primairePlus)) {
          months.add(monthKeyFor(dateForDay(weekKey, j.id)));
        }
      });
    });
  });
  res.json({ ok: true, months: Array.from(months).sort().reverse() });
});

// Détail de facturation par école pour un mois donné, rectifications comprises
// (les valeurs stockées sont déjà les valeurs finales, rectifications incluses).
app.get("/api/billing", (req, res) => {
  const { code, month } = req.query;
  if (!process.env.KITCHEN_CODE || code !== process.env.KITCHEN_CODE) {
    return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
  }
  if (!month) {
    return res.status(400).json({ ok: false, error: "Mois manquant." });
  }
  const data = loadData();
  const bySchool = {};

  Object.entries(data.orders).forEach(([weekKey, schools]) => {
    Object.values(schools).forEach((order) => {
      JOURS.forEach((j) => {
        const date = dateForDay(weekKey, j.id);
        if (monthKeyFor(date) !== month) return;
        const val = order.week[j.id] || {};
        const key = order.schoolName;
        if (!bySchool[key]) {
          bySchool[key] = { schoolName: key, soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0, jours: 0 };
        }
        bySchool[key].soupe += Number(val.soupe || 0);
        bySchool[key].maternelle += Number(val.maternelle || 0);
        bySchool[key].primaire += Number(val.primaire || 0);
        bySchool[key].primairePlus += Number(val.primairePlus || 0);
        bySchool[key].jours += 1;
      });
    });
  });

  const correctionsThisMonth = data.corrections.filter((c) => {
    const date = dateForDay(c.weekKey, c.dayId);
    return monthKeyFor(date) === month;
  });

  const schools = Object.values(bySchool).sort((a, b) => a.schoolName.localeCompare(b.schoolName, "fr"));
  const totals = schools.reduce(
    (acc, s) => ({
      soupe: acc.soupe + s.soupe,
      maternelle: acc.maternelle + s.maternelle,
      primaire: acc.primaire + s.primaire,
      primairePlus: acc.primairePlus + s.primairePlus,
    }),
    { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 }
  );

  res.json({ ok: true, schools, totals, corrections: correctionsThisMonth });
});

// Renvoie les commandes d'une semaine (pour la vue cuisine) — protégé par un code.
app.get("/api/orders", (req, res) => {
  const { weekKey, code } = req.query;
  const expected = process.env.KITCHEN_CODE;
  if (!expected) {
    return res.status(500).json({ ok: false, error: "Code cuisine non configuré côté serveur." });
  }
  if (!code || code !== expected) {
    return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
  }
  const data = loadData();
  const orders = weekKey ? data.orders[weekKey] || {} : {};
  // On ne renvoie jamais les emails des écoles à cet écran.
  const sanitized = Object.values(orders).map(({ schoolEmail, ...rest }) => rest);
  res.json({ ok: true, orders: sanitized });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
