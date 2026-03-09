/**
 * SHIFT ROUTES
 * Public:
 *  GET /api/shifts            -> open shifts (optional ?city=Seattle)
 *  GET /api/shifts/:id        -> shift detail
 * Auth (clinic):
 *  POST /api/shifts           -> create shift
 *  PUT /api/shifts/:id        -> update shift (owner only)
 *  DELETE /api/shifts/:id     -> delete shift (owner only)
 *  GET /api/shifts/mine       -> clinic's shifts
 * Admin:
 *  GET /api/shifts/admin/all  -> ALL shifts regardless of status
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function requireClinic(req, res, next) {
  try {
    const userId = req.user.id;
    const { data: profile, error } = await supabaseAdmin
        .from("profiles")
        .select("id, role, clinic_name, full_name, city")
        .eq("id", userId)
        .single();

    if (error || !profile) return res.status(403).json({ error: "Profile not found" });
    if (!["clinic", "admin"].includes(profile.role)) return res.status(403).json({ error: "Clinic access required" });

    req.profile = profile;
    return next();
  } catch (err) {
    console.error("requireClinic error:", err);
    return res.status(500).json({ error: "Server error" });
  }
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
    console.error("requireAdmin error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// IMPORTANT: define static paths BEFORE /:id to avoid route conflicts

// GET /api/shifts/mine — clinic's own shifts
router.get("/mine", authMiddleware, requireClinic, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
        .from("shifts")
        .select("*")
        .eq("clinic_id", req.user.id)
        .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ shifts: data });
  } catch (err) {
    console.error("GET /shifts/mine error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/shifts/admin/all — admin gets ALL shifts
router.get("/admin/all", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
        .from("shifts")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ shifts: data });
  } catch (err) {
    console.error("GET /shifts/admin/all error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/shifts — public, open shifts only
router.get("/", async (req, res) => {
  try {
    const city = (req.query.city || "").toString().trim();

    let q = supabaseAdmin
        .from("shifts")
        .select("*")
        .eq("status", "open")
        .order("date", { ascending: true });

    if (city) q = q.eq("city", city);

    const { data, error } = await q;
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ shifts: data });
  } catch (err) {
    console.error("GET /shifts error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/shifts/:id — public, shift detail
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid shift id" });

    const { data, error } = await supabaseAdmin
        .from("shifts")
        .select("*")
        .eq("id", id)
        .single();

    if (error || !data) return res.status(404).json({ error: "Shift not found" });

    return res.json({ shift: data });
  } catch (err) {
    console.error("GET /shifts/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/shifts — clinic creates shift
router.post("/", authMiddleware, requireClinic, async (req, res) => {
  try {
    const clinicId = req.user.id;
    const {
      role,
      city = req.profile.city || "Seattle",
      address = null,
      date,
      start_time,
      end_time,
      pay_per_hour = null,
      description = null,
      requirements = null
    } = req.body || {};

    if (!role || !date || !start_time || !end_time) {
      return res.status(400).json({ error: "role, date, start_time, end_time are required" });
    }

    const clinicName = req.profile.clinic_name || req.profile.full_name || "Clinic";

    const payload = {
      clinic_id: clinicId,
      clinic_name: clinicName,
      role,
      city,
      address,
      date,
      start_time,
      end_time,
      pay_per_hour,
      description,
      requirements,
      status: "open"
    };

    const { data, error } = await supabaseAdmin
        .from("shifts")
        .insert(payload)
        .select("*")
        .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.status(201).json({ message: "Shift created", shift: data });
  } catch (err) {
    console.error("POST /shifts error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/shifts/:id — clinic updates own shift
router.put("/:id", authMiddleware, requireClinic, async (req, res) => {
  try {
    const clinicId = req.user.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid shift id" });

    const { data: existing, error: exErr } = await supabaseAdmin
        .from("shifts")
        .select("id, clinic_id")
        .eq("id", id)
        .single();

    if (exErr || !existing) return res.status(404).json({ error: "Shift not found" });
    if (existing.clinic_id !== clinicId) return res.status(403).json({ error: "Not allowed" });

    const allowed = ["role","city","address","date","start_time","end_time","pay_per_hour","description","requirements","status"];
    const updates = {};
    for (const k of allowed) {
      if (k in (req.body || {})) updates[k] = req.body[k];
    }

    const { data, error } = await supabaseAdmin
        .from("shifts")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.json({ message: "Shift updated", shift: data });
  } catch (err) {
    console.error("PUT /shifts/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/shifts/:id — clinic deletes own shift
router.delete("/:id", authMiddleware, requireClinic, async (req, res) => {
  try {
    const clinicId = req.user.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid shift id" });

    const { data: existing, error: exErr } = await supabaseAdmin
        .from("shifts")
        .select("id, clinic_id")
        .eq("id", id)
        .single();

    if (exErr || !existing) return res.status(404).json({ error: "Shift not found" });
    if (existing.clinic_id !== clinicId) return res.status(403).json({ error: "Not allowed" });

    const { error } = await supabaseAdmin.from("shifts").delete().eq("id", id);
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ message: "Shift deleted" });
  } catch (err) {
    console.error("DELETE /shifts/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;