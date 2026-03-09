/**
 * UPLOAD ROUTES
 *
 * POST /api/upload/resume  -> worker uploads resume PDF/doc, stored in Supabase Storage
 *                             returns { url, path } for saving with the application
 * GET  /api/upload/resume/:applicationId -> clinic gets a signed download URL
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const authMiddleware = require("../middleware/authMiddleware");
const multer = require("multer");

const router = express.Router();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Use memory storage — buffer goes straight to Supabase Storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowed = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Only PDF and Word documents are allowed"));
    }
});

async function getProfile(userId) {
    const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
    return data;
}

/**
 * POST /api/upload/resume
 * Worker uploads their resume. Returns the storage path + public URL.
 */
router.post("/resume", authMiddleware, upload.single("resume"), async (req, res) => {
    try {
        const profile = await getProfile(req.user.id);
        if (!profile || profile.role !== "worker") {
            return res.status(403).json({ error: "Worker access required" });
        }

        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const ext = req.file.originalname.split(".").pop().toLowerCase();
        const fileName = `${req.user.id}_${Date.now()}.${ext}`;
        const storagePath = `resumes/${fileName}`;

        const { error: uploadError } = await supabase.storage
            .from("carevia-files")
            .upload(storagePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true,
            });

        if (uploadError) {
            console.error("Supabase Storage upload error:", uploadError);
            return res.status(500).json({ error: "File upload failed: " + uploadError.message });
        }

        // Generate a long-lived signed URL (7 days)
        const { data: signed, error: signErr } = await supabase.storage
            .from("carevia-files")
            .createSignedUrl(storagePath, 60 * 60 * 24 * 7);

        if (signErr) return res.status(500).json({ error: "Could not generate download URL" });

        return res.json({
            url:       signed.signedUrl,
            path:      storagePath,
            file_name: req.file.originalname,
        });
    } catch (err) {
        console.error("POST /upload/resume error:", err);
        return res.status(500).json({ error: err.message || "Server error" });
    }
});

/**
 * GET /api/upload/resume/:applicationId
 * Clinic requests a fresh signed download URL for an applicant's resume.
 * Only works if the clinic owns the shift this application is for.
 */
router.get("/resume/:applicationId", authMiddleware, async (req, res) => {
    try {
        const profile = await getProfile(req.user.id);
        if (!profile || profile.role !== "clinic") {
            return res.status(403).json({ error: "Clinic access required" });
        }

        const appId = Number(req.params.applicationId);
        const { data: app, error: appErr } = await supabase
            .from("applications")
            .select("*, shifts(clinic_id)")
            .eq("id", appId)
            .single();

        if (appErr || !app) return res.status(404).json({ error: "Application not found" });
        if (app.shifts?.clinic_id !== req.user.id) return res.status(403).json({ error: "Not your applicant" });
        if (!app.resume_path) return res.status(404).json({ error: "No resume uploaded for this applicant" });

        const { data: signed, error: signErr } = await supabase.storage
            .from("carevia-files")
            .createSignedUrl(app.resume_path, 60 * 60); // 1 hour

        if (signErr) return res.status(500).json({ error: "Could not generate download URL" });

        return res.json({ url: signed.signedUrl, file_name: app.resume_name });
    } catch (err) {
        console.error("GET /upload/resume error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;