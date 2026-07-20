// Serveur complet : sert les pages du site (formulaire école + vue cuisine +
// facturation), enregistre les commandes dans Supabase (base de données
// persistante, qui survit aux redéploiements), et envoie les emails de
// confirmation via Brevo.
//
// Réglages via variables d'environnement dans Render :
// BREVO_API_KEY, SENDER_EMAIL, SENDER_NAME, KITCHEN_CODE,
// SUPABASE_URL, SUPABASE_SERVICE_KEY

const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const JOURS = [
  { id: "lundi", label: "Lundi" },
  { id: "mardi", label: "Mardi" },
  { id: "jeudi", label: "Jeudi" },
  { id: "vendredi", label: "Vendredi" },
];

// ---------- Utilitaires ----------
function hashCode(code) {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

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

// Heure actuelle à Bruxelles, en valeurs calendaires complètes (année/mois/jour/heure/minute).
function brusselsNowFull() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
  };
}

function toComparableKey({ year, month, day, hour, minute }) {
  return year * 100000000 + month * 1000000 + day * 10000 + hour * 100 + minute;
}

// Un jour donné (dans une semaine donnée) reste rectifiable jusqu'à 9h15,
// heure de Bruxelles, LE JOUR MÊME — pas seulement "aujourd'hui" : les jours
// à venir dans la semaine restent ouverts jusqu'à leur propre échéance.
function isDayCorrectionOpen(weekKey, dayId) {
  const dayDate = dateForDay(weekKey, dayId);
  const cutoff = toComparableKey({
    year: dayDate.getUTCFullYear(),
    month: dayDate.getUTCMonth() + 1,
    day: dayDate.getUTCDate(),
    hour: 9,
    minute: 15,
  });
  const now = toComparableKey(brusselsNowFull());
  return now <= cutoff;
}

function getISOWeekKeyForDate(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-S${String(weekNo).padStart(2, "0")}`;
}

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

function emptyWeek() {
  return {
    lundi: { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 },
    mardi: { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 },
    jeudi: { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 },
    vendredi: { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 },
  };
}

// ---------- Accès base de données (Supabase) ----------
async function getSchool(nameLower) {
  const { data, error } = await supabase.from("schools").select("*").eq("id", nameLower).maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertSchool(nameLower, schoolName, codeHash, schoolEmail) {
  const fields = { id: nameLower, school_name: schoolName, code_hash: codeHash };
  if (schoolEmail) fields.school_email = schoolEmail;
  const { error } = await supabase.from("schools").upsert(fields);
  if (error) throw error;
}

async function getAllSchools() {
  const { data, error } = await supabase.from("schools").select("id, school_name, school_email").order("school_name");
  if (error) throw error;
  return data;
}

function generateNewCode() {
  return String(crypto.randomInt(100000, 999999)); // code à 6 chiffres
}

async function setSchoolNewCode(nameLower, newCode) {
  const hash = hashCode(newCode);
  const { error } = await supabase.from("schools").update({ code_hash: hash }).eq("id", nameLower);
  if (error) throw error;
}

async function getOrder(weekKey, nameLower) {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("week_key", weekKey)
    .eq("school_name_lower", nameLower)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertOrder(fields) {
  const { error } = await supabase.from("orders").upsert(fields, { onConflict: "week_key,school_name_lower" });
  if (error) throw error;
}

async function getOrdersForWeek(weekKey) {
  const { data, error } = await supabase.from("orders").select("*").eq("week_key", weekKey);
  if (error) throw error;
  return data;
}

async function getAllOrders() {
  const { data, error } = await supabase.from("orders").select("*");
  if (error) throw error;
  return data;
}

async function logCorrection(entry) {
  const { error } = await supabase.from("corrections").insert(entry);
  if (error) throw error;
}

async function getAllCorrections() {
  const { data, error } = await supabase.from("corrections").select("*");
  if (error) throw error;
  return data;
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
      sender: { name: process.env.SENDER_NAME || "Restaurant", email: process.env.SENDER_EMAIL },
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

async function sendNewCodeEmail({ schoolEmail, schoolName, newCode }) {
  const html = `
    <p>Bonjour,</p>
    <p>Votre code d'accès pour <strong>${schoolName}</strong> a été réinitialisé à votre demande.</p>
    <p>Votre nouveau code d'accès est :</p>
    <p style="font-size:22px;font-weight:bold;letter-spacing:2px;background:#f2efe5;padding:10px 16px;display:inline-block;border-radius:8px">${newCode}</p>
    <p>Utilisez-le lors de votre prochaine connexion pour retrouver vos commandes.</p>
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
      sender: { name: process.env.SENDER_NAME || "Restaurant", email: process.env.SENDER_EMAIL },
      to: [{ email: schoolEmail, name: schoolName }],
      subject: `Nouveau code d'accès - ${schoolName}`,
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
      sender: { name: process.env.SENDER_NAME || "Restaurant", email: process.env.SENDER_EMAIL },
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

app.post("/api/access", async (req, res) => {
  try {
    const { schoolName, code, schoolEmail } = req.body || {};
    if (!schoolName || !code) {
      return res.status(400).json({ ok: false, error: "Nom d'école et code requis." });
    }
    const nameLower = schoolName.trim().toLowerCase();
    const hash = hashCode(code);
    const school = await getSchool(nameLower);

    if (school) {
      // École déjà connue : le code doit correspondre, sans aucune exception,
      // même juste après une réinitialisation (le nouveau code est alors déjà
      // fixé et envoyé par email — il ne peut jamais être choisi librement ici).
      if (school.code_hash !== hash) {
        return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
      }
      if (schoolEmail) await upsertSchool(nameLower, schoolName.trim(), hash, schoolEmail.trim());
    } else {
      // Toute première commande de cette école : ce code devient son code d'accès.
      await upsertSchool(nameLower, schoolName.trim(), hash, schoolEmail ? schoolEmail.trim() : null);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const { schoolName, schoolEmail, code, weekKey, weekLabel, week, comment } = req.body || {};
    if (!schoolName || !schoolEmail || !code || !weekKey || !week) {
      return res.status(400).json({ ok: false, error: "Informations manquantes." });
    }
    const nameLower = schoolName.trim().toLowerCase();
    const hash = hashCode(code);
    const school = await getSchool(nameLower);

    if (school && school.code_hash !== hash) {
      return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
    }
    if (!school) {
      await upsertSchool(nameLower, schoolName.trim(), hash);
    }

    await upsertOrder({
      week_key: weekKey,
      school_name_lower: nameLower,
      school_name: schoolName.trim(),
      school_email: schoolEmail.trim(),
      week,
      comment: comment || "",
      submitted_at: new Date().toISOString(),
    });

    let emailSent = false;
    let emailError = null;
    try {
      await sendConfirmationEmail({ schoolEmail: schoolEmail.trim(), schoolName: schoolName.trim(), weekLabel, week, comment });
      emailSent = true;
    } catch (e) {
      emailError = e.message;
    }

    res.json({ ok: true, emailSent, emailError });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

app.post("/api/orders/mine", async (req, res) => {
  try {
    const { schoolName, code, weekKey } = req.body || {};
    if (!schoolName || !code || !weekKey) {
      return res.status(400).json({ ok: false, error: "Informations manquantes." });
    }
    const nameLower = schoolName.trim().toLowerCase();
    const hash = hashCode(code);
    const school = await getSchool(nameLower);

    if (!school || school.code_hash !== hash) {
      return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
    }

    const row = await getOrder(weekKey, nameLower);
    const order = row
      ? { schoolName: row.school_name, schoolEmail: row.school_email, week: row.week, comment: row.comment }
      : null;

    const days = JOURS.map((j) => ({
      id: j.id,
      label: j.label,
      editable: isDayCorrectionOpen(weekKey, j.id),
      date: dateForDay(weekKey, j.id).toISOString(),
    }));

    res.json({
      ok: true,
      order,
      days,
      currentWeekKey: getISOWeekKeyForDate(new Date()),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

app.post("/api/orders/correction", async (req, res) => {
  try {
    const { schoolName, code, dayId, delta } = req.body || {};
    if (!schoolName || !code || !dayId || !delta) {
      return res.status(400).json({ ok: false, error: "Informations manquantes." });
    }

    const weekKey = getISOWeekKeyForDate(new Date());

    if (!JOURS.some((j) => j.id === dayId)) {
      return res.status(400).json({ ok: false, error: "Jour invalide." });
    }
    if (!isDayCorrectionOpen(weekKey, dayId)) {
      return res.status(403).json({ ok: false, error: "La fenêtre de rectification (avant 9h15 le jour même) est fermée pour ce jour." });
    }

    const nameLower = schoolName.trim().toLowerCase();
    const hash = hashCode(code);
    const school = await getSchool(nameLower);
    if (!school || school.code_hash !== hash) {
      return res.status(401).json({ ok: false, error: "Code incorrect pour cette école." });
    }

    const row = await getOrder(weekKey, nameLower);
    if (!row) {
      return res.status(404).json({ ok: false, error: "Aucune commande trouvée pour cette semaine." });
    }

    const week = row.week || emptyWeek();
    const dayValues = week[dayId] || { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 };
    const newValues = {
      soupe: Math.max(0, Number(dayValues.soupe || 0) + Number(delta.soupe || 0)),
      maternelle: Math.max(0, Number(dayValues.maternelle || 0) + Number(delta.maternelle || 0)),
      primaire: Math.max(0, Number(dayValues.primaire || 0) + Number(delta.primaire || 0)),
      primairePlus: Math.max(0, Number(dayValues.primairePlus || 0) + Number(delta.primairePlus || 0)),
    };
    week[dayId] = newValues;

    await upsertOrder({
      week_key: weekKey,
      school_name_lower: nameLower,
      school_name: row.school_name,
      school_email: row.school_email,
      week,
      comment: row.comment,
      submitted_at: row.submitted_at,
    });

    await logCorrection({
      school_name: row.school_name,
      week_key: weekKey,
      day_id: dayId,
      delta,
      new_values: newValues,
    });

    const dayLabel = JOURS.find((j) => j.id === dayId)?.label || dayId;
    let emailSent = false;
    let emailError = null;
    try {
      await sendCorrectionEmail({ schoolEmail: row.school_email, schoolName: row.school_name, dayLabel, delta, newValues });
      emailSent = true;
    } catch (e) {
      emailError = e.message;
    }

    res.json({ ok: true, newValues, emailSent, emailError });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

// Modification manuelle des quantités par la cuisine (ex. correction d'un bug signalé
// par une école). Chaque changement est journalisé comme une rectification, pour
// apparaître dans l'historique de facturation.
app.post("/api/orders/admin-edit", async (req, res) => {
  try {
    const { code, schoolName, weekKey, week } = req.body || {};
    if (!process.env.KITCHEN_CODE || code !== process.env.KITCHEN_CODE) {
      return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
    }
    if (!schoolName || !weekKey || !week) {
      return res.status(400).json({ ok: false, error: "Informations manquantes." });
    }
    const nameLower = schoolName.trim().toLowerCase();
    const row = await getOrder(weekKey, nameLower);
    if (!row) {
      return res.status(404).json({ ok: false, error: "Aucune commande trouvée pour cette école et cette semaine." });
    }

    const oldWeek = row.week || emptyWeek();
    for (const j of JOURS) {
      const oldV = oldWeek[j.id] || { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 };
      const newV = week[j.id] || oldV;
      const delta = {
        soupe: Number(newV.soupe || 0) - Number(oldV.soupe || 0),
        maternelle: Number(newV.maternelle || 0) - Number(oldV.maternelle || 0),
        primaire: Number(newV.primaire || 0) - Number(oldV.primaire || 0),
        primairePlus: Number(newV.primairePlus || 0) - Number(oldV.primairePlus || 0),
      };
      const hasChange = Object.values(delta).some((v) => v !== 0);
      if (hasChange) {
        await logCorrection({
          school_name: row.school_name,
          week_key: weekKey,
          day_id: j.id,
          delta,
          new_values: newV,
        });
      }
    }

    await upsertOrder({
      week_key: weekKey,
      school_name_lower: nameLower,
      school_name: row.school_name,
      school_email: row.school_email,
      week,
      comment: row.comment,
      submitted_at: row.submitted_at,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

// Annuaire des écoles (nom + email), pour la page Facturation.
app.get("/api/schools", async (req, res) => {
  try {
    const { code } = req.query;
    if (!process.env.KITCHEN_CODE || code !== process.env.KITCHEN_CODE) {
      return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
    }
    const schools = await getAllSchools();
    res.json({
      ok: true,
      schools: schools.map((s) => ({ schoolName: s.school_name, schoolEmail: s.school_email || null })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

// Réinitialise le code d'accès d'une école (elle en choisira un nouveau à sa
// prochaine connexion). Les codes eux-mêmes ne sont jamais récupérables : ils
// sont enregistrés chiffrés (à sens unique), pas en clair.
app.post("/api/schools/reset-code", async (req, res) => {
  try {
    const { code, schoolName } = req.body || {};
    if (!process.env.KITCHEN_CODE || code !== process.env.KITCHEN_CODE) {
      return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
    }
    if (!schoolName) {
      return res.status(400).json({ ok: false, error: "Nom d'école manquant." });
    }
    const nameLower = schoolName.trim().toLowerCase();
    const school = await getSchool(nameLower);
    if (!school) {
      return res.status(404).json({ ok: false, error: "École introuvable." });
    }
    if (!school.school_email) {
      return res.status(400).json({
        ok: false,
        error: "Aucun email connu pour cette école — impossible d'envoyer le nouveau code en sécurité. Demandez-lui de se connecter une fois avec son code habituel (son email se synchronisera automatiquement), puis réessayez.",
      });
    }

    const newCode = generateNewCode();
    await setSchoolNewCode(nameLower, newCode);
    await sendNewCodeEmail({ schoolEmail: school.school_email, schoolName: school.school_name, newCode });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const { weekKey, code } = req.query;
    const expected = process.env.KITCHEN_CODE;
    if (!expected) {
      return res.status(500).json({ ok: false, error: "Code cuisine non configuré côté serveur." });
    }
    if (!code || code !== expected) {
      return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
    }
    const rows = weekKey ? await getOrdersForWeek(weekKey) : [];
    const orders = rows.map((r) => ({ schoolName: r.school_name, week: r.week, comment: r.comment }));
    res.json({ ok: true, orders });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

app.get("/api/billing/months", async (req, res) => {
  try {
    const { code } = req.query;
    if (!process.env.KITCHEN_CODE || code !== process.env.KITCHEN_CODE) {
      return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
    }
    const rows = await getAllOrders();
    const months = new Set();
    rows.forEach((r) => {
      JOURS.forEach((j) => {
        const val = (r.week || {})[j.id];
        if (val && (val.soupe || val.maternelle || val.primaire || val.primairePlus)) {
          months.add(monthKeyFor(dateForDay(r.week_key, j.id)));
        }
      });
    });
    res.json({ ok: true, months: Array.from(months).sort().reverse() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

app.get("/api/billing", async (req, res) => {
  try {
    const { code, month } = req.query;
    if (!process.env.KITCHEN_CODE || code !== process.env.KITCHEN_CODE) {
      return res.status(401).json({ ok: false, error: "Code cuisine incorrect." });
    }
    if (!month) {
      return res.status(400).json({ ok: false, error: "Mois manquant." });
    }
    const rows = await getAllOrders();
    const bySchool = {};

    rows.forEach((r) => {
      JOURS.forEach((j) => {
        const date = dateForDay(r.week_key, j.id);
        if (monthKeyFor(date) !== month) return;
        const val = (r.week || {})[j.id] || {};
        const key = r.school_name;
        if (!bySchool[key]) {
          bySchool[key] = { schoolName: key, soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 };
        }
        bySchool[key].soupe += Number(val.soupe || 0);
        bySchool[key].maternelle += Number(val.maternelle || 0);
        bySchool[key].primaire += Number(val.primaire || 0);
        bySchool[key].primairePlus += Number(val.primairePlus || 0);
      });
    });

    const allCorrections = await getAllCorrections();
    const correctionsThisMonth = allCorrections
      .filter((c) => monthKeyFor(dateForDay(c.week_key, c.day_id)) === month)
      .map((c) => ({
        timestamp: c.timestamp,
        schoolName: c.school_name,
        weekKey: c.week_key,
        dayId: c.day_id,
        delta: c.delta,
        newValues: c.new_values,
      }));

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
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Erreur serveur, réessayez." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
