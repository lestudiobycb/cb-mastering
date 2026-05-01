const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { exec } = require("child_process");
const Stripe = require("stripe");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STRIPE_PAYMENT_LINK =
  process.env.STRIPE_PAYMENT_LINK ||
  "https://buy.stripe.com/dRm9AU9ETfdB289dCpcfK0d";

const GMAIL_USER = process.env.GMAIL_USER || "lestudiobycb@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

app.use(cors({ origin: "*" }));

app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") {
    next();
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true }));

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD
  }
});

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -i "${filePath}" -show_entries format=duration -v quiet -of csv="p=0"`,
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout));
      }
    );
  });
}

async function generatePreview(inputPath, outputPath) {
  const duration = await getAudioDuration(inputPath);

  let start = 0;

  if (duration > 40) {
    start = Math.floor(duration / 2 - 15);
  }

  const cmd = `ffmpeg -y -ss ${start} -i "${inputPath}" -t 30 -af "highpass=f=25,lowpass=f=18500,acompressor=threshold=-18dB:ratio=2:attack=15:release=120,alimiter=limit=-2.0dB" -q:a 4 "${outputPath}"`;

  return runCommand(cmd);
}

async function downloadFromS3(key, localPath) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key
  });

  const response = await s3.send(command);
  const stream = fs.createWriteStream(localPath);

  return new Promise((resolve, reject) => {
    response.Body.pipe(stream);
    response.Body.on("error", reject);
    stream.on("finish", resolve);
  });
}

async function uploadToS3(localPath, key, contentType) {
  const fileStream = fs.createReadStream(localPath);

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: fileStream,
    ContentType: contentType
  });

  await s3.send(command);
}

async function getSignedDownloadUrl(key, expiresIn = 3600 * 24) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key
  });

  return getSignedUrl(s3, command, { expiresIn });
}

async function getObjectMetadata(key) {
  const command = new HeadObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key
  });

  return s3.send(command);
}

function buildStripePaymentLink(projectId, email = "") {
  const url = new URL(STRIPE_PAYMENT_LINK);

  url.searchParams.set("client_reference_id", projectId);

  if (email) {
    url.searchParams.set("prefilled_email", email);
  }

  return url.toString();
}

async function sendStudioNewMasteringEmail({
  projectId,
  clientEmail,
  originalFileUrl,
  previewUrl
}) {
  await resend.emails.send({
    from: "CB Production <onboarding@resend.dev>",
    to: "lestudiobycb@gmail.com",
    subject: `🎧 Nouveau mastering CB - ${clientEmail || projectId}`,
    html: `
      <div style="font-family: Arial; line-height:1.6;">
        <h2>🎧 Nouveau mastering à traiter</h2>

        <p><strong>Project ID :</strong> ${projectId}</p>
        <p><strong>Email client :</strong> ${clientEmail || "Non renseigné"}</p>

        <hr>

        <p><strong>Fichier original à masteriser :</strong></p>
        <p><a href="${originalFileUrl}">Télécharger le fichier original</a></p>

        <p><strong>Preview générée automatiquement :</strong></p>
        <p><a href="${previewUrl}">Écouter / télécharger la preview</a></p>

        <hr>

        <p>Retourner le master final à :</p>
        <p><strong>${clientEmail || "email client non disponible"}</strong></p>

        <p style="color:#888;">CB Production System</p>
      </div>
    `
  });
}

async function sendClientPaymentEmail(to, projectId) {
  const html = `
    <div style="font-family: Arial; line-height:1.6;">
      <h2>Paiement confirmé</h2>
      <p>Votre titre a bien été reçu et votre paiement est confirmé.</p>
      <p>Le master final est maintenant en cours de traitement par CB Production.</p>
      <p>Vous recevrez votre master directement par email dès qu'il sera prêt.</p>
      <br>
      <p style="opacity:0.6;">CB Production</p>
    </div>
  `;

  await transporter.sendMail({
    from: GMAIL_USER,
    to,
    subject: "CB Production - Mastering en cours",
    html
  });
}

async function sendStudioPaidEmail(projectId, clientEmail) {
  const inputKey = `uploads/${projectId}/original.wav`;
  const originalFileUrl = await getSignedDownloadUrl(inputKey);

  const html = `
    <div style="font-family: Arial; line-height:1.6;">
      <h2>🔥 MASTERING PAYÉ</h2>

      <p><strong>Project ID :</strong> ${projectId}</p>
      <p><strong>Email client :</strong> ${clientEmail || "Non renseigné"}</p>

      <p>Le client a payé. Tu peux lancer le mastering final.</p>

      <p>
        🎧 <a href="${originalFileUrl}">Télécharger le fichier original à masteriser</a>
      </p>

      <p>
        Retourner le master final à :
        <br>
        <strong>${clientEmail || "email client non disponible"}</strong>
      </p>

      <p style="color:#888;">CB Production System</p>
    </div>
  `;

  await transporter.sendMail({
    from: GMAIL_USER,
    to: GMAIL_USER,
    subject: `🔥 MASTER PAYÉ À FAIRE - ${clientEmail || projectId}`,
    html
  });
}

async function createMasteringJob({ projectId, preset, clientEmail }) {
  const job = {
    id: projectId,
    status: "waiting_preview",
    preset: preset || "warm",
    clientEmail: clientEmail || "",
    inputKey: `uploads/${projectId}/original.wav`,
    previewKey: `previews/${projectId}/preview.mp3`,
    masterKey: `masters/${projectId}/master.wav`,
    createdAt: new Date().toISOString()
  };

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `jobs/${projectId}.json`,
    Body: JSON.stringify(job, null, 2),
    ContentType: "application/json"
  });

  await s3.send(command);

  return job;
}

async function createMasteringJob({ projectId, preset, clientEmail }) {
  const job = {
    id: projectId,
    status: "waiting_preview",
    preset: preset || "warm",
    clientEmail: clientEmail || "",
    inputKey: `uploads/${projectId}/original.wav`,
    previewKey: `previews/${projectId}/preview.wav`,
    masterKey: `masters/${projectId}/master.wav`,
    createdAt: new Date().toISOString()
  };

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `jobs/${projectId}.json`,
    Body: JSON.stringify(job, null, 2),
    ContentType: "application/json"
  });

  await s3.send(command);
  return job;
}

app.post("/create-project", async (req, res) => {
  try {
    console.log("📦 CREATE-PROJECT BODY:", req.body);

    const projectId = crypto.randomUUID();
    const { email } = req.body || {};

    const key = `uploads/${projectId}/original.wav`;

    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      ContentType: "audio/wav",
      Metadata: {
        email: email || "",
        projectid: projectId
      }
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    res.json({
      projectId,
      uploadUrl
    });
  } catch (err) {
    console.error("❌ create-project error:", err);

    res.status(500).json({
      error: "create-project failed",
      details: err.message
    });
  }
});

app.post("/generate-preview", async (req, res) => {
  try {
    const { projectId, preset } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: "projectId manquant" });
    }

    const inputKey = `uploads/${projectId}/original.wav`;

    const metadata = await getObjectMetadata(inputKey);
    const clientEmail =
      metadata.Metadata?.email ||
      metadata.metadata?.email ||
      "";

    const job = await createMasteringJob({
      projectId,
      preset: preset || "warm",
      clientEmail
    });

    res.json({
      success: true,
      message: "Job créé pour le worker Logic",
      job
    });
  } catch (err) {
    console.error("❌ generate-preview job error:", err);

    res.status(500).json({
      error: "Erreur création job preview",
      details: err.message
    });
  }
});

app.get("/preview/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;

    const key = `previews/${projectId}/preview.mp3`;

    await getObjectMetadata(key);

    const url = await getSignedDownloadUrl(key, 3600);

    res.json({
      success: true,
      url,
      key
    });
  } catch (err) {
    console.error("❌ preview error:", err);

    res.status(404).json({
      success: false,
      error: "Preview pas encore prête",
      details: err.message
    });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { projectId, email } = req.body;

    if (!projectId) {
      return res.status(400).json({
        error: "projectId manquant"
      });
    }

    let clientEmail = email || "";

    if (!clientEmail) {
      try {
        const inputKey = `uploads/${projectId}/original.wav`;
        const metadata = await getObjectMetadata(inputKey);
        clientEmail = metadata.Metadata?.email || "";
      } catch (err) {
        console.warn("⚠️ Impossible de récupérer l'email depuis S3 :", err.message);
      }
    }

    const paymentUrl = buildStripePaymentLink(projectId, clientEmail);

    res.json({
      url: paymentUrl
    });
  } catch (err) {
    console.error("❌ Payment link error:", err);

    res.status(500).json({
      error: err.message
    });
  }
});

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  console.log("🔥 WEBHOOK HIT");

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("✅ Event reçu :", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const projectId =
      session.client_reference_id ||
      session.metadata?.projectId ||
      null;

    console.log("💰 Paiement validé pour projet:", projectId);

    if (!projectId) {
      console.log("⚠️ Aucun projectId trouvé dans la session Stripe.");
      return res.json({ received: true });
    }

    const inputKey = `uploads/${projectId}/original.wav`;

    try {
      const metadata = await getObjectMetadata(inputKey);

      const clientEmail =
        metadata.Metadata?.email ||
        metadata.metadata?.email ||
        session.customer_details?.email ||
        session.customer_email ||
        "";

      if (clientEmail) {
        await sendClientPaymentEmail(clientEmail, projectId);
        await sendStudioPaidEmail(projectId, clientEmail);

        console.log("📧 Mails envoyés : client + studio");
      } else {
        console.log("⚠️ Aucun email trouvé pour ce projet.");
      }
    } catch (err) {
      console.error("❌ Erreur post-paiement :", err);
    }
  }

  res.json({ received: true });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/test-env", (req, res) => {
  res.json({
    region: process.env.AWS_REGION,
    bucket: process.env.AWS_BUCKET_NAME,
    hasAwsKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasAwsSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
    hasGmailUser: !!process.env.GMAIL_USER,
    hasGmailPassword: !!process.env.GMAIL_APP_PASSWORD,
    hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    hasStripeWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
    paymentLink: STRIPE_PAYMENT_LINK
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CB Mastering Workflow running on port ${PORT}`);
});