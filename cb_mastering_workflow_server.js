const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");

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
const STUDIO_EMAIL = "lestudiobycb@gmail.com";

const ABBY_API_KEY = process.env.ABBY_API_KEY;
const ABBY_BASE_URL = (process.env.ABBY_BASE_URL || "https://api.app-abby.com").trim();

const MASTERING_PRICE = Number(process.env.MASTERING_PRICE || 9);

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

async function getSignedDownloadUrl(key, expiresIn = 3600 * 24 * 7) {
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

async function getJsonFromS3(key) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key
  });

  const response = await s3.send(command);

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function putJsonToS3(key, data) {
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json"
  });

  await s3.send(command);
}

function buildStripePaymentLink(projectId, email = "") {
  const url = new URL(STRIPE_PAYMENT_LINK);

  url.searchParams.set("client_reference_id", projectId);

  if (email) {
    url.searchParams.set("prefilled_email", email);
  }

  return url.toString();
}

async function abbyRequest(path, options = {}) {
  if (!ABBY_API_KEY) {
    throw new Error("ABBY_API_KEY manquante");
  }

  const response = await fetch(`${ABBY_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ABBY_API_KEY}`,
      Accept: "*/*",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Abby API ${response.status}: ${text}`);
  }

  return data;
}

async function abbyDownloadPdf(invoiceId) {
  if (!ABBY_API_KEY) {
    throw new Error("ABBY_API_KEY manquante");
  }

  const response = await fetch(
    `${ABBY_BASE_URL}/v2/billing/${invoiceId}/download?locale=fr`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ABBY_API_KEY}`,
        Accept: "application/pdf"
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Téléchargement facture Abby impossible: ${response.status} ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function createAbbyContact({ email }) {
  const name = email?.split("@")[0] || "Client";
  const safeName = name.replace(/[._-]/g, " ");

  return abbyRequest("/contact", {
    method: "POST",
    body: JSON.stringify({
      firstname: safeName || "Client",
      lastname: "Client CB",
      emails: [email]
    })
  });
}

async function createAbbyInvoice({ customerId, projectId, amount }) {
  const invoice = await abbyRequest(`/v2/billing/invoice/${customerId}`, {
    method: "POST",
    body: JSON.stringify({})
  });

  const invoiceId = invoice.id;

  if (!invoiceId) {
    throw new Error("Abby n’a pas retourné d’ID de facture");
  }

  await abbyRequest(`/v2/billing/${invoiceId}/lines`, {
    method: "PATCH",
    body: JSON.stringify({
      lines: [
        {
          designation: "Mastering automatique CB Production",
          description: `Mastering automatique en ligne - Projet ${projectId}`,
          reference: `CB-MASTER-${projectId}`,
          quantity: 1,
          quantityUnit: "unit",
          unitPrice: amount,
          unitPriceHT: amount,
          type: "commercial_or_craft_services"
        }
      ]
    })
  });

  const finalized = await abbyRequest(`/v2/billing/${invoiceId}/finalize`, {
    method: "PATCH",
    body: JSON.stringify({})
  });

  return finalized || invoice;
}

async function createAbbyInvoiceForPayment({ projectId, clientEmail, amount }) {
  const contact = await createAbbyContact({ email: clientEmail });

  const contactId = contact.id;

  if (!contactId) {
    throw new Error("Abby n’a pas retourné d’ID client");
  }

  const invoice = await createAbbyInvoice({
    customerId: contactId,
    projectId,
    amount
  });

  const invoiceId = invoice.id;

  let invoicePdfBuffer = null;

  try {
    invoicePdfBuffer = await abbyDownloadPdf(invoiceId);
  } catch (err) {
    console.error("⚠️ Facture créée mais PDF Abby non récupéré :", err.message);
  }

  return {
    contactId,
    invoiceId,
    invoice,
    invoicePdfBuffer
  };
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
    paid: false,
    createdAt: new Date().toISOString()
  };

  await putJsonToS3(`jobs/${projectId}.json`, job);

  return job;
}

async function markJobAsPaid(projectId, clientEmail, extra = {}) {
  const jobKey = `jobs/${projectId}.json`;

  let job;

  try {
    job = await getJsonFromS3(jobKey);
  } catch {
    job = {
      id: projectId,
      status: "paid_no_preview_job",
      preset: "warm",
      clientEmail: clientEmail || "",
      inputKey: `uploads/${projectId}/original.wav`,
      previewKey: `previews/${projectId}/preview.wav`,
      masterKey: `masters/${projectId}/master.wav`,
      createdAt: new Date().toISOString()
    };
  }

  const updatedJob = {
    ...job,
    ...extra,
    paid: true,
    clientEmail: clientEmail || job.clientEmail || "",
    paidAt: new Date().toISOString(),
    status: "paid_master_delivered"
  };

  await putJsonToS3(jobKey, updatedJob);

  return updatedJob;
}

async function sendClientFinalEmail({
  to,
  projectId,
  masterUrl,
  invoicePdfBuffer,
  invoiceId
}) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6; color:#111;">
      <h2>Votre master est prêt 🎧</h2>

      <p>Merci pour votre commande.</p>

      <p>Votre master final est disponible ici :</p>

      <p>
        <a href="${masterUrl}" style="display:inline-block;padding:12px 18px;background:#d9903d;color:#fff;text-decoration:none;font-weight:bold;">
          Télécharger le master final
        </a>
      </p>

      <p><strong>Référence projet :</strong> ${projectId}</p>
      <p><strong>Facture Abby :</strong> ${invoiceId || "création facture indisponible"}</p>

      ${
        invoicePdfBuffer
          ? `<p>La facture est jointe à cet email au format PDF.</p>`
          : `<p>La facture sera disponible séparément si nécessaire.</p>`
      }

      <br>

      <p style="opacity:0.65;">
        Merci pour votre confiance,<br>
        CB Production
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"CB Production" <${GMAIL_USER}>`,
    to,
    subject: "CB Production - Votre master est prêt",
    html,
    attachments: invoicePdfBuffer
      ? [
          {
            filename: `facture-cb-production-${projectId}.pdf`,
            content: invoicePdfBuffer,
            contentType: "application/pdf"
          }
        ]
      : []
  });
}

async function sendStudioPaidEmail({
  projectId,
  clientEmail,
  masterUrl,
  invoiceId
}) {
  const inputKey = `uploads/${projectId}/original.wav`;
  const previewKey = `previews/${projectId}/preview.wav`;
  const masterKey = `masters/${projectId}/master.wav`;

  const originalFileUrl = await getSignedDownloadUrl(inputKey);

  let previewUrl = "";
  try {
    await getObjectMetadata(previewKey);
    previewUrl = await getSignedDownloadUrl(previewKey);
  } catch {
    previewUrl = "";
  }

  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6; color:#111;">
      <h2>🔥 MASTERING PAYÉ ET LIVRÉ</h2>

      <p><strong>Project ID :</strong> ${projectId}</p>
      <p><strong>Email client :</strong> ${clientEmail || "Non renseigné"}</p>
      <p><strong>Facture Abby :</strong> ${invoiceId || "non créée"}</p>

      <hr>

      <p><strong>Fichier original :</strong></p>
      <p><a href="${originalFileUrl}">Télécharger le fichier original</a></p>

      ${
        previewUrl
          ? `<p><strong>Preview :</strong></p><p><a href="${previewUrl}">Écouter / télécharger la preview</a></p>`
          : `<p><strong>Preview :</strong> introuvable.</p>`
      }

      <p><strong>Master final :</strong></p>
      <p><a href="${masterUrl}">Télécharger le master final</a></p>

      <p><strong>Master key S3 :</strong> ${masterKey}</p>

      <p style="color:#888;">CB Production System</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"CB Production System" <${GMAIL_USER}>`,
    to: STUDIO_EMAIL,
    subject: `✅ MASTER LIVRÉ - ${clientEmail || projectId}`,
    html
  });
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

    const key = `previews/${projectId}/preview.wav`;

    await getObjectMetadata(key);

    const url = await getSignedDownloadUrl(key, 3600);

    res.json({
      success: true,
      ready: true,
      url,
      key
    });
  } catch {
    res.status(404).json({
      success: false,
      ready: false,
      error: "Preview pas encore prête"
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
    const masterKey = `masters/${projectId}/master.wav`;

    try {
      const metadata = await getObjectMetadata(inputKey);

      const clientEmail =
        metadata.Metadata?.email ||
        metadata.metadata?.email ||
        session.customer_details?.email ||
        session.customer_email ||
        "";

      if (!clientEmail) {
        console.log("⚠️ Aucun email trouvé pour ce projet.");
        return res.json({ received: true });
      }

      console.log("🔎 Vérification du master :", masterKey);

      await getObjectMetadata(masterKey);
      const masterUrl = await getSignedDownloadUrl(masterKey, 3600 * 24 * 7);

      let abbyInvoice = null;

      try {
        abbyInvoice = await createAbbyInvoiceForPayment({
          projectId,
          clientEmail,
          amount: MASTERING_PRICE
        });

        console.log("🧾 Facture Abby créée :", abbyInvoice.invoiceId);
      } catch (abbyErr) {
        console.error("❌ Erreur création facture Abby, mais mail maintenu :", abbyErr.message);
      }

      await markJobAsPaid(projectId, clientEmail, {
        masterKey,
        abbyInvoiceId: abbyInvoice?.invoiceId || null,
        deliveredAt: new Date().toISOString()
      });

      await sendClientFinalEmail({
        to: clientEmail,
        projectId,
        masterUrl,
        invoicePdfBuffer: abbyInvoice?.invoicePdfBuffer || null,
        invoiceId: abbyInvoice?.invoiceId || null
      });

      await sendStudioPaidEmail({
        projectId,
        clientEmail,
        masterUrl,
        invoiceId: abbyInvoice?.invoiceId || null
      });

      console.log("📧 Mail client + mail studio envoyés");
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
    hasAbbyKey: !!process.env.ABBY_API_KEY,
    abbyBaseUrl: ABBY_BASE_URL,
    masteringPrice: MASTERING_PRICE,
    paymentLink: STRIPE_PAYMENT_LINK
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CB Mastering Workflow running on port ${PORT}`);
});