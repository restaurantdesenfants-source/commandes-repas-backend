// ---- Fonctions partagées entre la page École et la page Cuisine ----

const JOURS = [
  { id: "lundi", label: "Lundi" },
  { id: "mardi", label: "Mardi" },
  { id: "jeudi", label: "Jeudi" },
  { id: "vendredi", label: "Vendredi" },
];

const CHAMPS = [
  { id: "soupe", label: "Soupe", unit: "L", step: "0.5" },
  { id: "maternelle", label: "Repas maternelle", unit: "" },
  { id: "primaire", label: "Repas primaire", unit: "" },
  { id: "primairePlus", label: "Repas primaire +", unit: "" },
];

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

// La commande se fait le jeudi avant 15h, pour la semaine d'école suivante.
function getTargetMonday(now = new Date()) {
  const day = now.getDay();
  const thisThursday = new Date(now);
  thisThursday.setDate(now.getDate() + (4 - day));
  thisThursday.setHours(15, 0, 0, 0);

  const mondayOfThisWeek = new Date(thisThursday);
  mondayOfThisWeek.setDate(thisThursday.getDate() - 3);
  mondayOfThisWeek.setHours(0, 0, 0, 0);

  const nextWeekMonday = new Date(mondayOfThisWeek);
  nextWeekMonday.setDate(mondayOfThisWeek.getDate() + 7);

  if (now <= thisThursday) {
    return { monday: nextWeekMonday, deadline: thisThursday, deadlinePassed: false };
  }
  const followingWeekMonday = new Date(nextWeekMonday);
  followingWeekMonday.setDate(nextWeekMonday.getDate() + 7);
  return { monday: followingWeekMonday, deadline: thisThursday, deadlinePassed: true };
}

function weekLabelFor(monday) {
  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);
  const fmt = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  return `${fmt(monday)} — ${fmt(friday)}`;
}

function weekKeyFor(monday) {
  const { year, week } = getISOWeek(monday);
  return `${year}-S${String(week).padStart(2, "0")}`;
}

// Lundi de la semaine EN COURS (pas la semaine ciblée par les nouvelles commandes) —
// utilisé pour les rectifications du jour même.
function getCurrentWeekMonday(now = new Date()) {
  const day = now.getDay(); // 0=dim ... 1=lun ... 6=sam
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Heure actuelle à Bruxelles (gère automatiquement l'heure d'été/hiver), sans dépendance.
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

// La rectification du jour n'est ouverte qu'un jour d'école, avant 9h15 (heure de Bruxelles).
function isCorrectionWindowOpen() {
  const { weekday, hour, minute } = brusselsNow();
  const schoolDays = [1, 2, 4, 5]; // lundi, mardi, jeudi, vendredi
  if (!schoolDays.includes(weekday)) return false;
  return hour < 9 || (hour === 9 && minute <= 15);
}

function todayDayId() {
  const { weekday } = brusselsNow();
  const map = { 1: "lundi", 2: "mardi", 4: "jeudi", 5: "vendredi" };
  return map[weekday] || null;
}

function fmtDeadline(d) {
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) + " à 15h";
}

function emptyDay() {
  return { soupe: 0, maternelle: 0, primaire: 0, primairePlus: 0 };
}

function emptyWeek() {
  return { lundi: emptyDay(), mardi: emptyDay(), jeudi: emptyDay(), vendredi: emptyDay() };
}

function renderDeadlineBar() {
  const { monday, deadline, deadlinePassed } = getTargetMonday();
  const bar = document.getElementById("deadline-bar");
  if (!bar) return { monday, deadline, deadlinePassed };
  bar.textContent =
    `Commandes à valider avant ${fmtDeadline(deadline)} pour la semaine du ${weekLabelFor(monday)}` +
    (deadlinePassed ? " (semaine suivante, échéance de cette semaine dépassée)" : "");
  return { monday, deadline, deadlinePassed };
}
