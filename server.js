// Petit serveur qui reçoit une commande depuis le formulaire des écoles
// et envoie l'email de confirmation via Brevo.
//
// Il n'y a rien à comprendre en détail ici : suivez le guide de déploiement,
// vous n'aurez jamais besoin de modifier ce fichier.

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const JOURS = [
  { id: "lundi", label: "Lundi" },
  { id: "mardi", label: "Mardi" },
  { id: "jeudi", label: "Jeudi" },
  { id: "vendredi", label: "Vendredi" },
];

// Page d'accueil simple, juste pour vérifier que le serveur tourne.
app.get("/", (req, res) => {
  res.send("Serveur de confirmation de commande — opérationnel.");
});

// C'est ici que le formulaire des écoles enverra la commande.
app.post("/api/confirmation", async (req, res) => {
  try {
    const { schoolEmail, schoolName, weekLabel, week, comment } = req.body;

    if (!schoolEmail || !schoolName || !weekLabel || !week) {
      return res.status(400).json({ error: "Informations manquantes dans la commande." });
    }

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

    const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
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

    if (!brevoResponse.ok) {
      const errText = await brevoResponse.text();
      console.error("Erreur Brevo :", errText);
      return res.status(502).json({ error: "L'envoi de l'email a échoué." });
    }

    const result = await brevoResponse.json();
    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
