/**
 * /api/auth
 * POST /signup                  -> create user + profile; clinics start as status:'pending'
 * POST /login                   -> sign in; blocks pending clinics with friendly message
 * GET  /me                      -> protected profile
 * POST /logout                  -> sign out
 * --- ADMIN ---
 * GET  /admin/users             -> all profiles (admin only)
 * DELETE /admin/users/:id       -> remove user (admin only)
 * POST /admin/approve/:id       -> approve a pending clinic, sends notification email
 * POST /admin/reject/:id        -> reject a pending clinic
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);
const supabaseAuth = supabaseAdmin;

// ── Email transporter (uses env vars — works with Gmail, SendGrid, Resend, etc.)
function getMailer() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const FROM_EMAIL = process.env.FROM_EMAIL || "ceravia0@gmail.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "ceravia0@gmail.com";
const APP_URL = process.env.APP_URL || "http://localhost:4000";

async function sendEmail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[EMAIL SKIPPED — no SMTP configured]\nTo: ${to}\nSubject: ${subject}`);
    return;
  }
  try {
    const mailer = getMailer();
    await mailer.sendMail({ from: `CareVia <${FROM_EMAIL}>`, to, subject, html });
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err.message);
  }
}

function normalizeError(msg = "") {
  const m = String(msg).toLowerCase();
  if (m.includes("invalid login credentials")) return "Invalid email or password";
  if (m.includes("already registered")) return "Email already in use";
  if (m.includes("email") && m.includes("already")) return "Email already in use";
  return msg || "Server error";
}

async function requireAdmin(req, res, next) {
  try {
    const { data: profile, error } = await supabaseAdmin
        .from("profiles")
        .select("role")
        .eq("id", req.user.id)
        .single();
    if (error || !profile) return res.status(403).json({ error: "Profile not found" });
    if (profile.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    return next();
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}

// ─────────────────────────────────────────────
// POST /api/auth/signup
// ─────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { email, password, full_name, role, phone, clinic_name, city, address, specialty, npi_number, license_number, docs_submitted, requirements_confirmed } = req.body || {};

    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: "Please fill in all fields" });
    }
    if (!["worker", "clinic", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (role === "clinic" && !clinic_name) {
      return res.status(400).json({ error: "Please enter your clinic name" });
    }
    // phone is optional — default to empty string if not provided

    // If email already exists in Auth, check profile status
    let existingRejectedId = null;
    try {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
      const existingAuthUser = users?.find(u => u.email?.toLowerCase() === email.toLowerCase());
      if (existingAuthUser) {
        const { data: existingProfile } = await supabaseAdmin
            .from("profiles")
            .select("id, status")
            .eq("id", existingAuthUser.id)
            .maybeSingle();

        if (!existingProfile) {
          // Profile was manually deleted — reuse the auth user
          existingRejectedId = existingAuthUser.id;
          await supabaseAdmin.auth.admin.updateUserById(existingRejectedId, { password });
        } else if (existingProfile.status === "rejected") {
          existingRejectedId = existingAuthUser.id;
          await supabaseAdmin.auth.admin.updateUserById(existingRejectedId, { password });
          try { await supabaseAdmin.from("profiles").delete().eq("id", existingRejectedId); } catch(_) {}
        } else {
          return res.status(409).json({ error: "Email already in use" });
        }
      }
    } catch(e) {
      console.error("pre-signup check error:", e.message);
    }

    let userId;

    if (existingRejectedId) {
      // Reuse the existing auth user — just update the profile
      userId = existingRejectedId;
      try { await supabaseAdmin.from("profiles").delete().eq("id", userId); } catch(_) {}
    } else {
      // Create brand new Supabase auth user
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createErr || !created?.user) {
        const msg = normalizeError(createErr?.message);
        return res.status(msg === "Email already in use" ? 409 : 400).json({ error: msg });
      }
      userId = created.user.id;
    }

    // Clinics start pending, everyone else is active
    const approvalStatus = role === "clinic" ? "pending" : "approved";

    const { data: profile, error: profErr } = await supabaseAdmin
        .from("profiles")
        .insert({
          id: userId,
          full_name,
          role,
          phone: phone || null,
          clinic_name: role === "clinic" ? clinic_name : null,
          city: city || "Seattle",
          address: address || null,
          specialty: specialty || null,
          npi_number: npi_number || null,
          license_number: license_number || null,
          docs_submitted: docs_submitted || null,
          requirements_confirmed: requirements_confirmed || false,
          status: approvalStatus,
        })
        .select("*")
        .single();

    if (profErr) {
      try { await supabaseAdmin.auth.admin.deleteUser(userId); } catch(_) {}
      return res.status(400).json({ error: profErr.message });
    }

    // ── Clinic signup: send emails, return pending status (no token yet)
    if (role === "clinic") {
      // 1. Email to the clinic
      await sendEmail({
        to: email,
        subject: "CareVia — Your clinic account is pending approval",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8faff;border-radius:12px">
            <div style="text-align:center;margin-bottom:28px">
              <span style="font-family:Georgia,serif;font-size:1.6rem;font-weight:900;color:#1a3a6b">Care<span style="color:#10b981">Via</span></span>
            </div>
            <h2 style="color:#0d1f3c;margin:0 0 12px">Thanks for signing up, ${full_name}!</h2>
            <p style="color:#475569;line-height:1.7;margin:0 0 16px">
              Your <strong>${clinic_name}</strong> clinic account has been created and is currently 
              <strong style="color:#d97706">pending admin approval</strong>.
            </p>
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px;margin:20px 0">
              <p style="margin:0;color:#475569;font-size:0.9rem;line-height:1.7">
                ✅ Our team will review your account shortly.<br>
                📧 You'll receive an email notification once you're approved.<br>
                ⏱️ Approval typically happens within 1 business day.
              </p>
            </div>
            <p style="color:#64748b;font-size:0.85rem;margin:0">
              Questions? Reply to this email or contact us at 
              <a href="mailto:${ADMIN_EMAIL}" style="color:#2563eb">${ADMIN_EMAIL}</a>
            </p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:0.75rem;text-align:center;margin:0">© 2025 CareVia Solutions LLC · Seattle, WA</p>
          </div>
        `,
      });

      // 2. Alert email to admin
      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `CareVia — New clinic signup pending approval: ${clinic_name}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8faff;border-radius:12px">
            <h2 style="color:#0d1f3c;margin:0 0 12px">🏥 New Clinic Signup — Needs Approval</h2>
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px;margin:16px 0">
              <table style="width:100%;font-size:0.9rem;color:#334155;border-collapse:collapse">
                <tr><td style="padding:6px 0;font-weight:700;width:130px">Clinic Name</td><td>${clinic_name}</td></tr>
                <tr><td style="padding:6px 0;font-weight:700">Contact Name</td><td>${full_name}</td></tr>
                <tr><td style="padding:6px 0;font-weight:700">Email</td><td>${email}</td></tr>
                <tr><td style="padding:6px 0;font-weight:700">Phone</td><td>${phone || "—"}</td></tr>
                <tr><td style="padding:6px 0;font-weight:700">User ID</td><td style="font-size:0.8rem;color:#64748b">${userId}</td></tr>
              </table>
            </div>
            <p style="color:#475569;font-size:0.9rem">
              Log in to the admin dashboard to approve or reject this clinic.
            </p>
            <a href="${APP_URL}/admin-dashboard.html" 
               style="display:inline-block;background:linear-gradient(135deg,#1a3a6b,#2563eb);color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:0.9rem;margin-top:8px">
              Open Admin Dashboard →
            </a>
          </div>
        `,
      });

      // Return pending — no token, no redirect to dashboard
      return res.status(201).json({
        pending: true,
        message: "Account created! Your clinic is pending admin approval. Check your email for details.",
        role: "clinic",
      });
    }

    // ── Worker / admin signup: sign in and return token immediately
    const { data: loginData, error: loginErr } = await supabaseAuth.auth.signInWithPassword({
      email,
      password,
    });

    if (loginErr || !loginData?.session?.access_token) {
      return res.status(400).json({ error: normalizeError(loginErr?.message) });
    }

    return res.status(201).json({
      user: { id: userId, email },
      token: loginData.session.access_token,
      role: profile.role,
      profile,
    });
  } catch (err) {
    console.error("signup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Please fill in all fields" });

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

    if (error || !data?.session?.access_token) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const { data: profile, error: profErr } = await supabaseAdmin
        .from("profiles")
        .select("role, full_name, clinic_name, phone, city, status")
        .eq("id", data.user.id)
        .single();

    if (profErr || !profile) return res.status(404).json({ error: "Profile not found" });

    // Block pending clinics
    if (profile.role === "clinic" && profile.status === "pending") {
      return res.status(403).json({
        error: "pending_approval",
        message: "Your clinic account is pending admin approval. You'll receive an email once approved.",
      });
    }

    // Block rejected clinics
    if (profile.role === "clinic" && profile.status === "rejected") {
      return res.status(403).json({
        error: "account_rejected",
        message: "Your clinic account was not approved. Contact ceravia0@gmail.com for assistance.",
      });
    }

    return res.json({
      user: { id: data.user.id, email: data.user.email },
      token: data.session.access_token,
      role: profile.role,
      profile,
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const { data: profile, error } = await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq("id", req.user.id)
        .single();
    if (error || !profile) return res.status(404).json({ error: "Profile not found" });
    return res.json({ profile });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    const supabaseWithToken = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY,
        { global: { headers: { Authorization: `Bearer ${req.token}` } } }
    );
    await supabaseWithToken.auth.signOut().catch(() => {});
    return res.json({ message: "Logged out" });
  } catch (err) {
    return res.json({ message: "Logged out" });
  }
});

// ─────────────────────────────────────────────
// GET /api/auth/admin/users
// ─────────────────────────────────────────────
router.get("/admin/users", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ users: data });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/admin/approve/:id
// ─────────────────────────────────────────────
router.post("/admin/approve/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    const { data: profile, error: fetchErr } = await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

    if (fetchErr || !profile) return res.status(404).json({ error: "User not found" });
    if (profile.role !== "clinic") return res.status(400).json({ error: "Only clinic accounts need approval" });
    if (profile.status === "approved") return res.status(400).json({ error: "Already approved" });

    // Update status to approved
    const { error: updateErr } = await supabaseAdmin
        .from("profiles")
        .update({ status: "approved" })
        .eq("id", userId);

    if (updateErr) return res.status(400).json({ error: updateErr.message });

    // Get the auth user's email
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const clinicEmail = authUser?.user?.email || profile.email;

    // Send approval notification email to clinic
    if (clinicEmail) {
      await sendEmail({
        to: clinicEmail,
        subject: "🎉 CareVia — Your clinic account has been approved!",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8faff;border-radius:12px">
            <div style="text-align:center;margin-bottom:28px">
              <span style="font-family:Georgia,serif;font-size:1.6rem;font-weight:900;color:#1a3a6b">Care<span style="color:#10b981">Via</span></span>
            </div>
            <div style="background:linear-gradient(135deg,#059669,#10b981);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
              <div style="font-size:2.5rem;margin-bottom:8px">✅</div>
              <h2 style="color:#fff;margin:0;font-size:1.4rem">Your Clinic is Approved!</h2>
            </div>
            <p style="color:#334155;line-height:1.7;margin:0 0 16px">
              Hi <strong>${profile.full_name}</strong>,
            </p>
            <p style="color:#475569;line-height:1.7;margin:0 0 20px">
              Great news! Your <strong>${profile.clinic_name}</strong> account on CareVia has been 
              <strong style="color:#059669">approved</strong>. You can now log in and start posting shifts to 
              connect with dental professionals in the Seattle area.
            </p>
            <div style="text-align:center;margin:28px 0">
              <a href="${APP_URL}/login.html" 
                 style="display:inline-block;background:linear-gradient(135deg,#1a3a6b,#2563eb);color:#fff;text-decoration:none;padding:14px 32px;border-radius:999px;font-weight:700;font-size:0.95rem;box-shadow:0 6px 20px rgba(37,99,235,0.35)">
                Log In to CareVia →
              </a>
            </div>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin-bottom:20px">
              <p style="margin:0;color:#065f46;font-size:0.875rem;line-height:1.7">
                <strong>Getting started:</strong><br>
                🏥 Complete your clinic profile<br>
                📋 Post your first shift<br>
                👤 Review applications from dental professionals
              </p>
            </div>
            <p style="color:#64748b;font-size:0.85rem;margin:0">
              Need help? Contact us at <a href="mailto:${ADMIN_EMAIL}" style="color:#2563eb">${ADMIN_EMAIL}</a>
            </p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:0.75rem;text-align:center;margin:0">© 2025 CareVia Solutions LLC · Seattle, WA</p>
          </div>
        `,
      });
    }

    return res.json({ message: "Clinic approved and notified", profile: { ...profile, status: "approved" } });
  } catch (err) {
    console.error("approve error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/admin/reject/:id
// ─────────────────────────────────────────────
router.post("/admin/reject/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { reason } = req.body || {};

    const { data: profile, error: fetchErr } = await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

    if (fetchErr || !profile) return res.status(404).json({ error: "User not found" });

    const { error: updateErr } = await supabaseAdmin
        .from("profiles")
        .update({ status: "rejected" })
        .eq("id", userId);

    if (updateErr) return res.status(400).json({ error: updateErr.message });

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const clinicEmail = authUser?.user?.email;

    if (clinicEmail) {
      await sendEmail({
        to: clinicEmail,
        subject: "CareVia — Update on your clinic account application",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f8faff;border-radius:12px">
            <div style="text-align:center;margin-bottom:28px">
              <span style="font-family:Georgia,serif;font-size:1.6rem;font-weight:900;color:#1a3a6b">Care<span style="color:#10b981">Via</span></span>
            </div>
            <h2 style="color:#0d1f3c;margin:0 0 12px">Update on Your Application</h2>
            <p style="color:#475569;line-height:1.7;margin:0 0 16px">
              Hi <strong>${profile.full_name}</strong>, unfortunately we were unable to approve 
              the <strong>${profile.clinic_name}</strong> clinic account at this time.
            </p>
            ${reason ? `<p style="color:#475569;line-height:1.7;margin:0 0 16px"><strong>Reason:</strong> ${reason}</p>` : ""}
            <p style="color:#475569;line-height:1.7;margin:0">
              If you think this is a mistake, please contact us at 
              <a href="mailto:${ADMIN_EMAIL}" style="color:#2563eb">${ADMIN_EMAIL}</a> and we'll be happy to help.
            </p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:0.75rem;text-align:center;margin:0">© 2025 CareVia Solutions LLC · Seattle, WA</p>
          </div>
        `,
      });
    }

    return res.json({ message: "Clinic rejected" });
  } catch (err) {
    console.error("reject error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/auth/admin/users/:id
// ─────────────────────────────────────────────
router.delete("/admin/users/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { error: profErr } = await supabaseAdmin.from("profiles").delete().eq("id", userId);
    if (profErr) return res.status(400).json({ error: profErr.message });
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authErr) console.warn("Auth user delete warning:", authErr.message);
    return res.json({ message: "User removed" });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/upload-doc
// Public endpoint — uploads a clinic doc to Supabase Storage
// ─────────────────────────────────────────────
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

router.post("/upload-doc", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const label = req.body.label || "doc";
    const email = (req.body.email || "unknown").replace(/[^a-zA-Z0-9]/g, "_");

    if (!file) return res.status(400).json({ error: "No file provided" });

    const ext = file.originalname.split(".").pop().toLowerCase();
    const allowed = ["pdf", "jpg", "jpeg", "png"];
    if (!allowed.includes(ext)) return res.status(400).json({ error: "Invalid file type" });

    const path = `clinic-docs/${email}/${label}_${Date.now()}.${ext}`;

    const { error: uploadErr } = await supabaseAdmin.storage
        .from("clinic-documents")
        .upload(path, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
        .from("clinic-documents")
        .getPublicUrl(path);

    return res.json({
      name: file.originalname,
      url: urlData.publicUrl,
      path,
    });
  } catch (err) {
    console.error("upload-doc error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

module.exports = router;