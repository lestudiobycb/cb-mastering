// CB Mastering Workflow - starter server
// ------------------------------------------------------------
// Ce fichier crée un mini système complet :
// 1) page client d'envoi
// 2) analyse audio FFmpeg pour calculer un gain recommandé
// 3) envoi d'un email à lestudiobycb@gmail.com avec les infos
// 4) page de suivi "en attente de mastering"
// 5) endpoint admin pour uploader un preview/master plus tard
// 6) page client mise à jour avec player + bouton de paiement quand le master est prêt
//
// AVERTISSEMENT:
// - C'est un starter MVP, pas un produit final blindé sécurité.
// - Pour l'email Gmail, crée un mot de passe d'application Google.
// - Pour le paiement, remplace STRIPE_PAYMENT_LINK par ton vrai lien Stripe.
//
// INSTALLATION
// npm init -y
// npm install express multer nodemailer cors
// FFmpeg doit être installé sur la machine
// node server.js
// ------------------------------------------------------------

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const { exec } = require('child_process');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const GMAIL_USER = process.env.GMAIL_USER || 'lestudiobycb@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || 'PUT_GMAIL_APP_PASSWORD_HERE';
const STRIPE_PAYMENT_LINK = process.env.STRIPE_PAYMENT_LINK || 'https://buy.stripe.com/test_replace_me';
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const MASTER_DIR = path.join(ROOT, 'masters');
const PREVIEW_DIR = path.join(ROOT, 'previews');

for (const dir of [DATA_DIR, UPLOAD_DIR, MASTER_DIR, PREVIEW_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/masters', express.static(MASTER_DIR));
app.use('/previews', express.static(PREVIEW_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.wav';
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }
});

function quote(value) {
  return `"${value}"`;
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

function generatePreview(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${inputPath}" -t 30 -q:a 4 "${outputPath}"`;

    exec(cmd, (error) => {
      if (error) {
        console.error("FFmpeg error:", error);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function jobsFilePath() {
  return path.join(DATA_DIR, 'jobs.json');
}

function loadJobs() {
  const file = jobsFilePath();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  fs.writeFileSync(jobsFilePath(), JSON.stringify(jobs, null, 2), 'utf8');
}

function getJob(jobId) {
  return loadJobs().find((job) => job.id === jobId);
}

function updateJob(jobId, updater) {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index === -1) return null;
  jobs[index] = updater(jobs[index]);
  saveJobs(jobs);
  return jobs[index];
}

function extractLoudnormJson(stderrText) {
  const match = stderrText.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!match) return null;
  return JSON.parse(match[0]);
}

function computeRecommendedGain(inputLufs, truePeak, lra) {
  // Réglage de départ pour ton template Logic, pas un gain final absolu.
  // Idée: rester prudent pour éviter de suralimenter ta chaîne.
  let gain = 0;

  if (inputLufs <= -22) gain = 7.0;
  else if (inputLufs <= -20) gain = 6.0;
  else if (inputLufs <= -18) gain = 5.0;
  else if (inputLufs <= -16) gain = 4.0;
  else if (inputLufs <= -14) gain = 2.5;
  else gain = 1.0;

  // Si le true peak est déjà très haut, on calme le gain recommandé.
  if (truePeak > -2.0) gain -= 1.5;
  else if (truePeak > -3.5) gain -= 0.8;

  // Si la dynamique est déjà serrée, on reste un peu prudent.
  if (lra < 4) gain -= 0.5;

  return Math.max(0, Number(gain.toFixed(1)));
}

async function analyzeTrack(filePath) {
  const command = `ffmpeg -i ${quote(filePath)} -af loudnorm=I=-10:TP=-1.0:LRA=9:print_format=json -f null -`;
  const result = await runCommand(command);
  const analysis = extractLoudnormJson(result.stderr);

  if (!analysis) {
    throw new Error('Impossible de lire l\'analyse loudnorm.');
  }

  const inputLufs = Number(parseFloat(analysis.input_i).toFixed(2));
  const truePeak = Number(parseFloat(analysis.input_tp).toFixed(2));
  const lra = Number(parseFloat(analysis.input_lra).toFixed(2));
  const threshold = Number(parseFloat(analysis.input_thresh).toFixed(2));
  const targetOffset = Number(parseFloat(analysis.target_offset).toFixed(2));
  const recommendedGain = computeRecommendedGain(inputLufs, truePeak, lra);

  return {
    inputLufs,
    truePeak,
    lra,
    threshold,
    targetOffset,
    recommendedGain,
    targetLufs: -10
  };
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

async function sendStudioEmail(job) {
  const statusUrl = `${BASE_URL}/status/${job.id}`;

  const html = `
    <h2>Nouveau mastering CB</h2>
    <p><strong>Projet :</strong> ${job.projectTitle}</p>
    <p><strong>Artiste :</strong> ${job.artistName}</p>
    <p><strong>Email client :</strong> ${job.email}</p>
    <p><strong>Fichier :</strong> ${job.originalFilename}</p>
    <hr />
    <p><strong>Analyse :</strong></p>
    <ul>
      <li>LUFS d'entrée : ${job.analysis.inputLufs}</li>
      <li>True Peak : ${job.analysis.truePeak} dBTP</li>
      <li>LRA : ${job.analysis.lra}</li>
      <li>Threshold : ${job.analysis.threshold}</li>
      <li>Target offset : ${job.analysis.targetOffset}</li>
      <li><strong>Gain recommandé pour Logic : +${job.analysis.recommendedGain} dB</strong></li>
    </ul>
    <p><strong>Page client :</strong> <a href="${statusUrl}">${statusUrl}</a></p>
    <p><strong>Fichier uploadé :</strong> <a href="${BASE_URL}${job.uploadUrl}">${BASE_URL}${job.uploadUrl}</a></p>
  `;

  await transporter.sendMail({
    from: GMAIL_USER,
    to: GMAIL_USER,
    subject: `Nouveau mastering - ${job.artistName} - ${job.projectTitle}`,
    html
  });
}

function htmlLayout(content, title = 'CB Studio') {
  return `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Arial, Helvetica, sans-serif;
        background: #050505;
        color: #f5e7c2;
        min-height: 100vh;
      }
      .wrap {
        width: 100%;
        max-width: 920px;
        margin: 0 auto;
        padding: 32px 18px 80px;
      }
      .card {
        background: #0d0d0d;
        border: 1px solid rgba(208,189,148,.22);
        border-radius: 24px;
        padding: 24px;
        box-shadow: 0 18px 40px rgba(0,0,0,.35);
      }
      h1,h2,h3,p { margin-top: 0; }
      h1 { color: #d0bd94; font-size: 34px; }
      h2 { color: #d0bd94; font-size: 24px; }
      .muted { color: rgba(255,255,255,.72); }
      label { display:block; margin: 0 0 8px; font-size: 14px; font-weight: 700; }
      input, textarea, button, select {
        width: 100%;
        border-radius: 14px;
        border: 1px solid rgba(208,189,148,.22);
        background: #141414;
        color: #fff;
        padding: 14px 16px;
        font-size: 15px;
      }
      textarea { min-height: 120px; resize: vertical; }
      input:focus, textarea:focus {
        outline: none;
        border-color: #d0bd94;
        box-shadow: 0 0 0 3px rgba(208,189,148,.12);
      }
      .grid { display:grid; gap:16px; }
      .grid-2 { display:grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap:16px; }
      .row { display:flex; gap:14px; flex-wrap:wrap; }
      .pill {
        display:inline-flex;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 700;
        background: rgba(208,189,148,.14);
        border: 1px solid rgba(208,189,148,.18);
        color: #f5e7c2;
      }
      button {
        cursor: pointer;
        background: #d0bd94;
        color: #000;
        font-weight: 800;
        border: none;
      }
      button.secondary {
        background: transparent;
        color: #f5e7c2;
        border: 1px solid rgba(208,189,148,.22);
      }
      .section { margin-top: 20px; }
      .status-waiting { color: #e4c47a; }
      .status-ready { color: #b5ff9e; }
      .status-paid { color: #9ed8ff; }
      .info-grid {
        display:grid;
        grid-template-columns: repeat(2,minmax(0,1fr));
        gap: 14px;
        margin-top: 18px;
      }
      .info-item {
        background: #131313;
        border: 1px solid rgba(208,189,148,.15);
        border-radius: 18px;
        padding: 14px;
      }
      .info-label {
        font-size: 12px;
        color: rgba(255,255,255,.55);
        margin-bottom: 6px;
      }
      .info-value {
        font-size: 18px;
        color: #fff;
        font-weight: 700;
      }
      .hidden { display:none; }
      .center { text-align:center; }
      audio { width: 100%; margin-top: 12px; }
      .small { font-size: 13px; color: rgba(255,255,255,.6); }
      a { color: #d0bd94; }
      .logo {
        width: 56px; height: 56px; border-radius: 16px; display:flex; align-items:center; justify-content:center;
        background: linear-gradient(135deg, #d0bd94, #92743b); color:#000; font-weight:900; margin-bottom:18px;
      }
      @media (max-width: 740px) {
        .grid-2, .info-grid { grid-template-columns: 1fr; }
        h1 { font-size: 28px; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">${content}</div>
  </body>
  </html>
  `;
}

app.get('/', (req, res) => {
  res.send(htmlLayout(`
    <div class="card">
      <div class="logo">CB</div>
      <h1>Mastering CB Studio</h1>
      <p class="muted">Envoyez votre mix, nous analysons le niveau automatiquement, nous recevons directement les infos studio par email, puis vous suivez l'avancement sur une page dédiée.</p>

      <form id="masterForm" class="grid" enctype="multipart/form-data">
        <div class="grid-2">
          <div>
            <label for="projectTitle">Titre du projet</label>
            <input id="projectTitle" name="projectTitle" type="text" placeholder="Midnight Lights" required />
          </div>
          <div>
            <label for="artistName">Nom de l'artiste</label>
            <input id="artistName" name="artistName" type="text" placeholder="Nom artiste / groupe" required />
          </div>
        </div>

        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" placeholder="artiste@email.com" required />
        </div>

        <div>
          <label for="track">Fichier audio</label>
          <input id="track" name="track" type="file" accept=".wav,.aiff,.aif,.flac,.mp3,.m4a" required />
          <p class="small">Formats acceptés : WAV, AIFF, FLAC, MP3, M4A.</p>
        </div>

        <button type="submit">Envoyer pour mastering</button>
      </form>

      <div id="result" class="section hidden"></div>
    </div>

    <script>
      const form = document.getElementById('masterForm');
      const result = document.getElementById('result');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        result.classList.remove('hidden');
        result.innerHTML = '<p class="muted">Upload en cours... analyse du mix... envoi studio...</p>';

        const formData = new FormData(form);

        try {
          const response = await fetch('/api/create-job', {
            method: 'POST',
            body: formData
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || 'Erreur inconnue');
          }

          window.location.href = '/status/' + data.jobId;
        } catch (error) {
          result.innerHTML = '<p style="color:#ff8d8d;">Erreur : ' + error.message + '</p>';
        }
      });
    </script>
  `, 'CB Mastering Upload'));
});

app.post('/api/create-job', upload.single('track'), async (req, res) => {
  try {
    const { projectTitle, artistName, email } = req.body;

    if (!projectTitle || !artistName || !email || !req.file) {
      return res.status(400).json({ error: 'Champs manquants.' });
    }

    const analysis = await analyzeTrack(req.file.path);
    const jobId = crypto.randomUUID();

    const job = {
      id: jobId,
      projectTitle,
      artistName,
      email,
      originalFilename: req.file.originalname,
      uploadFilename: req.file.filename,
      uploadUrl: `/uploads/${req.file.filename}`,
      createdAt: new Date().toISOString(),
      status: 'waiting_mastering',
      analysis,
      previewUrl: null,
      masterUrl: null,
      paid: false,
      notes: 'En attente de mastering par le studio.'
    };

    const jobs = loadJobs();
    jobs.push(job);
    saveJobs(jobs);

    await sendStudioEmail(job);

    return res.json({
      success: true,
      jobId,
      statusUrl: `/status/${jobId}`
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: 'Création du job impossible.',
      details: error.message
    });
  }
});

app.get('/api/job/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job introuvable.' });
  res.json(job);
});

app.get('/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).send(htmlLayout(`
      <div class="card center">
        <h1>Projet introuvable</h1>
        <p class="muted">Le lien de suivi n'existe pas ou n'est plus disponible.</p>
      </div>
    `, 'Projet introuvable'));
  }

  res.send(htmlLayout(`
    <div class="card">
      <div class="logo">CB</div>
      <div class="row">
        <span class="pill">CB Studio</span>
        <span class="pill">Suivi mastering</span>
      </div>

      <h1>${job.projectTitle}</h1>
      <p class="muted">Artiste : <strong>${job.artistName}</strong></p>

      <div id="statusArea">
        <p class="status-waiting"><strong>Statut actuel :</strong> En attente de mastering</p>
      </div>

      <div class="info-grid">
        <div class="info-item">
          <div class="info-label">Titre du projet</div>
          <div class="info-value">${job.projectTitle}</div>
        </div>
        <div class="info-item">
          <div class="info-label">Artiste</div>
          <div class="info-value">${job.artistName}</div>
        </div>
        <div class="info-item">
          <div class="info-label">Fichier reçu</div>
          <div class="info-value">${job.originalFilename}</div>
        </div>
        <div class="info-item">
          <div class="info-label">Email</div>
          <div class="info-value">${job.email}</div>
        </div>
      </div>

      <div class="section">
        <h2>Analyse du mix</h2>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">LUFS d'entrée</div>
            <div class="info-value" id="inputLufs">${job.analysis.inputLufs}</div>
          </div>
          <div class="info-item">
            <div class="info-label">True Peak</div>
            <div class="info-value" id="truePeak">${job.analysis.truePeak} dBTP</div>
          </div>
          <div class="info-item">
            <div class="info-label">LRA</div>
            <div class="info-value" id="lra">${job.analysis.lra}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Mastering note</div>
            <div class="info-value" id="recommendedGain">+${job.analysis.recommendedGain} dB</div>
          </div>
        </div>
        <p class="small">Le studio reçoit ces informations par email pour préparer le mastering.</p>
      </div>

      <div class="section" id="previewBlock">
        <h2>Écoute</h2>
        <div id="waitingView">
          <p class="muted">Votre titre est bien reçu. Le mastering est en cours de préparation. Revenez sur cette page plus tard pour écouter la preview.</p>
        </div>

        <div id="readyView" class="hidden">
          <p class="status-ready"><strong>La preview mastering est prête.</strong></p>
          <audio controls id="previewPlayer"></audio>
          <div class="section">
            <button id="buyButton">Payer et débloquer le master</button>
            <p class="small">Après paiement, vous pourrez recevoir le master final.</p>
          </div>
        </div>

        <div id="paidView" class="hidden">
          <p class="status-paid"><strong>Paiement confirmé.</strong></p>
          <audio controls id="masterPlayer"></audio>
          <p class="small">Votre master final est disponible à l'écoute et peut être livré au téléchargement.</p>
          <div class="section">
            <a id="downloadMaster" href="#" download>
              <button>Télécharger le master</button>
            </a>
          </div>
        </div>
      </div>
    </div>

    <script>
      const jobId = ${JSON.stringify(job.id)};
      const statusArea = document.getElementById('statusArea');
      const waitingView = document.getElementById('waitingView');
      const readyView = document.getElementById('readyView');
      const paidView = document.getElementById('paidView');
      const previewPlayer = document.getElementById('previewPlayer');
      const masterPlayer = document.getElementById('masterPlayer');
      const buyButton = document.getElementById('buyButton');
      const downloadMaster = document.getElementById('downloadMaster');

      buyButton.addEventListener('click', () => {
        window.location.href = ${JSON.stringify(STRIPE_PAYMENT_LINK)} + '?prefilled_email=' + encodeURIComponent(${JSON.stringify(job.email)});
      });

      async function refreshStatus() {
        const res = await fetch('/api/job/' + jobId);
        const data = await res.json();

        document.getElementById('inputLufs').textContent = data.analysis.inputLufs;
        document.getElementById('truePeak').textContent = data.analysis.truePeak + ' dBTP';
        document.getElementById('lra').textContent = data.analysis.lra;
        document.getElementById('recommendedGain').textContent = '+' + data.analysis.recommendedGain + ' dB';

        if (data.status === 'waiting_mastering') {
          statusArea.innerHTML = '<p class="status-waiting"><strong>Statut actuel :</strong> En attente de mastering</p>';
          waitingView.classList.remove('hidden');
          readyView.classList.add('hidden');
          paidView.classList.add('hidden');
        }

        if (data.status === 'preview_ready') {
          statusArea.innerHTML = '<p class="status-ready"><strong>Statut actuel :</strong> Preview prête à l\'écoute</p>';
          waitingView.classList.add('hidden');
          readyView.classList.remove('hidden');
          paidView.classList.add('hidden');
          if (data.previewUrl) previewPlayer.src = data.previewUrl;
        }

        if (data.status === 'paid' || data.status === 'master_ready') {
          statusArea.innerHTML = '<p class="status-paid"><strong>Statut actuel :</strong> Master débloqué</p>';
          waitingView.classList.add('hidden');
          readyView.classList.add('hidden');
          paidView.classList.remove('hidden');
          if (data.masterUrl) {
            masterPlayer.src = data.masterUrl;
            downloadMaster.href = data.masterUrl;
          }
        }
      }

      refreshStatus();
      setInterval(refreshStatus, 10000);
    </script>
  `, `Suivi - ${job.projectTitle}`));
});

// ------------------------------------------------------------
// ADMIN - upload manuel de la preview ou du master final
// Tu utilises ça après avoir masterisé dans Logic.
// ------------------------------------------------------------

app.get('/admin', (req, res) => {
  res.send(htmlLayout(`
    <div class="card">
      <div class="logo">CB</div>
      <h1>Admin mastering</h1>
      <p class="muted">Upload manuel d'une preview ou du master final après traitement dans Logic.</p>

      <form id="adminForm" class="grid" enctype="multipart/form-data">
        <div>
          <label for="adminKey">Clé admin</label>
          <input id="adminKey" name="adminKey" type="password" placeholder="Clé admin" required />
        </div>
        <div>
          <label for="jobId">Job ID</label>
          <input id="jobId" name="jobId" type="text" placeholder="UUID du projet" required />
        </div>
        <div>
          <label for="fileType">Type de fichier</label>
          <select id="fileType" name="fileType">
            <option value="preview">Preview</option>
            <option value="master">Master final</option>
          </select>
        </div>
        <div>
          <label for="audioFile">Fichier à envoyer</label>
          <input id="audioFile" name="audioFile" type="file" accept=".wav,.aiff,.aif,.flac,.mp3,.m4a" required />
        </div>
        <button type="submit">Uploader sur la page client</button>
      </form>

      <div id="adminResult" class="section hidden"></div>
    </div>

    <script>
      const adminForm = document.getElementById('adminForm');
      const adminResult = document.getElementById('adminResult');

      adminForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        adminResult.classList.remove('hidden');
        adminResult.innerHTML = '<p class="muted">Upload en cours...</p>';

        const formData = new FormData(adminForm);

        const response = await fetch('/api/admin/upload-result', {
          method: 'POST',
          body: formData
        });

        const data = await response.json();

        if (!response.ok) {
          adminResult.innerHTML = '<p style="color:#ff8d8d;">Erreur : ' + (data.error || 'Erreur inconnue') + '</p>';
          return;
        }

        adminResult.innerHTML = '<p style="color:#b5ff9e;">OK. Page client mise à jour : <a href="/status/' + data.jobId + '">ouvrir</a></p>';
      });
    </script>
  `, 'Admin mastering'));
});

app.post('/api/admin/upload-result', upload.single('audioFile'), async (req, res) => {
  try {
    const { adminKey, jobId, fileType } = req.body;

    if (adminKey !== ADMIN_KEY) {
      return res.status(403).json({ error: 'Clé admin invalide.' });
    }

    const existingJob = getJob(jobId);
    if (!existingJob) {
      return res.status(404).json({ error: 'Projet introuvable.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Fichier audio manquant.' });
    }

    const destinationDir = fileType === 'master' ? MASTER_DIR : PREVIEW_DIR;
    const newFilename = `${jobId}-${fileType}${path.extname(req.file.originalname) || '.mp3'}`;
    const newPath = path.join(destinationDir, newFilename);
    fs.renameSync(req.file.path, newPath);

    const publicUrl = fileType === 'master'
      ? `/masters/${newFilename}`
      : `/previews/${newFilename}`;

    const updatedJob = updateJob(jobId, (job) => {
      const next = { ...job };

      if (fileType === 'preview') {
        next.previewUrl = publicUrl;
        next.status = 'preview_ready';
        next.notes = 'Preview prête à l\'écoute.';
      }

      if (fileType === 'master') {
        next.masterUrl = publicUrl;
        next.status = 'master_ready';
        next.notes = 'Master final prêt.';
      }

      return next;
    });

    return res.json({ success: true, jobId: updatedJob.id, status: updatedJob.status });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Upload résultat impossible.', details: error.message });
  }
});

// ------------------------------------------------------------
// ADMIN - marquer un projet comme payé
// En V1: tu peux le faire manuellement après Stripe.
// Plus tard: tu brancheras un vrai webhook Stripe.
// ------------------------------------------------------------

app.post('/api/admin/mark-paid', (req, res) => {
  const { adminKey, jobId } = req.body;

  if (adminKey !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Clé admin invalide.' });
  }

  const job = updateJob(jobId, (existing) => {
    const next = { ...existing };
    next.paid = true;
    next.status = 'paid';
    return next;
  });

  if (!job) {
    return res.status(404).json({ error: 'Projet introuvable.' });
  }

  res.json({ success: true, jobId: job.id, status: job.status });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get("/test-env", (req, res) => {
  res.json({
    region: process.env.AWS_REGION,
    bucket: process.env.AWS_BUCKET_NAME,
    hasKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
  });
});

app.get("/upload-test", async (req, res) => {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: "uploads/test.wav",
      ContentType: "audio/wav",
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 60 });
    res.send(url);
  } catch (error) {
    console.error("Erreur upload-test :", error);
    res.status(500).send("Erreur génération URL upload");
  }
});

app.get("/test-preview", async (req, res) => {
  try {
    const input = "./uploads/test.wav";
    const output = "./previews/test.mp3";

    await generatePreview(input, output);

    res.send("Preview généré !");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur preview");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CB Mastering Workflow running on ${BASE_URL}`);
});