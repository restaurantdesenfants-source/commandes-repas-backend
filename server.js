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
    return JSON.parse(raw);
  } catch (e) {
    return { schools: {}, orders: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
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

// Renvoie les commandes d'une semaine (pour la vue cuisine).
app.get("/api/orders", (req, res) => {
  const { weekKey } = req.query;
  const data = loadData();
  const orders = weekKey ? data.orders[weekKey] || {} : {};
  res.json({ ok: true, orders: Object.values(orders) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
