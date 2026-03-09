/**
 * APPLICATION ROUTES
 * Auth required for all.
 *
 * POST /api/applications/:shiftId   -> worker applies to shift
 * GET  /api/applications/mine       -> worker views own applications
 * GET  /api/applications/shift/:id  -> clinic views applicants for their shift
 * PUT  /api/applications/:id        -> clinic accepts/rejects
 * --- ADMIN ---
 * GET  /api/applications/admin/all  -> ALL applications (admin only)
 * PUT  /api/applications/admin/:id  -> accept/reject any application (admin only)
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function loadProfile(req, res, next) {
  try {
    const userId = req.user.id;
    const { data: profile, error } = await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

    if (error || !profile) return res.status(403).json({ error: "Profile not found" });

    req.profile = profile;
    return next();
  } catch (err) {
    console.error("loadProfile error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

// GET /api/applications/mine — worker views own applications
router.get("/mine", authMiddleware, loadProfile, async (req, res) => {
  try {
    if (req.profile.role !== "worker") {
      return res.status(403).json({ error: "Worker access required" });
    }

    const { data, error } = await supabaseAdmin
        .from("applications")
        .select("*")
        .eq("worker_id", req.user.id)
        .order("applied_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ applications: data });
  } catch (err) {
    console.error("GET /applications/mine error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/applications/admin/all — admin views ALL applications
router.get("/admin/all", authMiddleware, loadProfile, async (req, res) => {
  try {
    if (req.profile.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { data, error } = await supabaseAdmin
        .from("applications")
        .select("*")
        .order("applied_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ applications: data });
  } catch (err) {
    console.error("GET /applications/admin/all error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/applications/:shiftId — worker applies
router.post("/:shiftId", authMiddleware, loadProfile, async (req, res) => {
  try {
    if (req.profile.role !== "worker") {
      return res.status(403).json({ error: "Worker access required" });
    }

    const shiftId = Number(req.params.shiftId);
    if (!Number.isFinite(shiftId)) return res.status(400).json({ error: "Invalid shift id" });

    const { data: shift, error: shiftErr } = await supabaseAdmin
        .from("shifts")
        .select("id, status")
        .eq("id", shiftId)
        .single();

    if (shiftErr || !shift) return res.status(404).json({ error: "Shift not found" });
    if (shift.status !== "open") return res.status(400).json({ error: "Shift is not open" });

    const { data: existing } = await supabaseAdmin
        .from("applications")
        .select("id")
        .eq("shift_id", shiftId)
        .eq("worker_id", req.user.id)
        .maybeSingle();

    if (existing?.id) {
      return res.status(409).json({ error: "You already applied to this shift" });
    }

    const workerName = req.profile.full_name || "Worker";

    const payload = {
      shift_id:     shiftId,
      worker_id:    req.user.id,
      worker_name:  workerName,
      status:       "pending",
      cover_letter: req.body.cover_letter || null,
      experience:   req.body.experience   || null,
      license:      req.body.license      || null,
      cpr:          req.body.cpr          || null,
      xray:         req.body.xray         || null,
      software:     req.body.software     || null,
      availability: req.body.availability || null,
      source:       req.body.source       || null,
      resume_name:  req.body.resume_name  || null,
      resume_path:  req.body.resume_path  || null,
    };

    const { data, error } = await supabaseAdmin
        .from("applications")
        .insert(payload)
        .select("*")
        .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.status(201).json({ message: "Applied", application: data });
  } catch (err) {
    console.error("POST /applications/:shiftId error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/applications/shift/:id — clinic views applicants for their shift
router.get("/shift/:id", authMiddleware, loadProfile, async (req, res) => {
  try {
    if (req.profile.role !== "clinic") {
      return res.status(403).json({ error: "Clinic access required" });
    }

    const shiftId = Number(req.params.id);
    if (!Number.isFinite(shiftId)) return res.status(400).json({ error: "Invalid shift id" });

    const { data: shift, error: shiftErr } = await supabaseAdmin
        .from("shifts")
        .select("id, clinic_id")
        .eq("id", shiftId)
        .single();

    if (shiftErr || !shift) return res.status(404).json({ error: "Shift not found" });
    if (shift.clinic_id !== req.user.id) return res.status(403).json({ error: "Not allowed" });

    const { data: apps, error } = await supabaseAdmin
        .from("applications")
        .select("*")
        .eq("shift_id", shiftId)
        .order("applied_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    return res.json({ applications: apps });
  } catch (err) {
    console.error("GET /applications/shift/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/applications/admin/:id — admin accepts/rejects any application
router.put("/admin/:id", authMiddleware, loadProfile, async (req, res) => {
  try {
    if (req.profile.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const appId = Number(req.params.id);
    if (!Number.isFinite(appId)) return res.status(400).json({ error: "Invalid application id" });

    const { status } = req.body || {};
    if (!["accepted", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ error: "status must be accepted, rejected, or pending" });
    }

    const { data, error } = await supabaseAdmin
        .from("applications")
        .update({ status })
        .eq("id", appId)
        .select("*")
        .single();

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: "Application updated", application: data });
  } catch (err) {
    console.error("PUT /applications/admin/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/applications/:id — clinic accepts/rejects
router.put("/:id", authMiddleware, loadProfile, async (req, res) => {
  try {
    if (req.profile.role !== "clinic") {
      return res.status(403).json({ error: "Clinic access required" });
    }

    const appId = Number(req.params.id);
    if (!Number.isFinite(appId)) return res.status(400).json({ error: "Invalid application id" });

    const { status } = req.body || {};
    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'accepted' or 'rejected'" });
    }

    const { data: appRow, error: appErr } = await supabaseAdmin
        .from("applications")
        .select("id, shift_id, status")
        .eq("id", appId)
        .single();

    if (appErr || !appRow) return res.status(404).json({ error: "Application not found" });

    const { data: shift, error: shiftErr } = await supabaseAdmin
        .from("shifts")
        .select("id, clinic_id")
        .eq("id", appRow.shift_id)
        .single();

    if (shiftErr || !shift) return res.status(404).json({ error: "Shift not found" });
    if (shift.clinic_id !== req.user.id) return res.status(403).json({ error: "Not allowed" });

    const { data, error } = await supabaseAdmin
        .from("applications")
        .update({ status })
        .eq("id", appId)
        .select("*")
        .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.json({ message: "Application updated", application: data });
  } catch (err) {
    console.error("PUT /applications/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;