/**
 * MESSAGES ROUTES
 *
 * Conversations are between a worker and a clinic, tied to an application.
 * Clinic can message ANY applicant.
 * Worker can only message clinics where their application is ACCEPTED.
 *
 * GET  /api/messages/conversations       -> list all conversations for current user
 * GET  /api/messages/:conversationId     -> get messages in a conversation
 * POST /api/messages/:conversationId     -> send a message
 * POST /api/messages/start/:applicationId -> start or get conversation for an application
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function getProfile(userId) {
    const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
    return data;
}

/**
 * POST /start/:applicationId
 * Creates or retrieves a conversation for a given application.
 * Clinic can start with any applicant. Worker only if accepted.
 */
router.post("/start/:applicationId", authMiddleware, async (req, res) => {
    try {
        const profile = await getProfile(req.user.id);
        if (!profile) return res.status(403).json({ error: "Profile not found" });

        const appId = Number(req.params.applicationId);

        // Load the application
        const { data: app, error: appErr } = await supabase
            .from("applications")
            .select("*, shifts(clinic_id, clinic_name, role)")
            .eq("id", appId)
            .single();

        if (appErr || !app) return res.status(404).json({ error: "Application not found" });

        // Permission check
        if (profile.role === "worker") {
            if (app.worker_id !== req.user.id) return res.status(403).json({ error: "Not your application" });
        } else if (profile.role === "clinic") {
            const clinicId = app.shifts?.clinic_id;
            if (clinicId !== req.user.id) return res.status(403).json({ error: "Not your applicant" });
        }

        // Check if conversation already exists — workers can always VIEW existing convos
        const { data: existing } = await supabase
            .from("conversations")
            .select("*")
            .eq("application_id", appId)
            .maybeSingle();

        if (existing) {
            existing.id = Number(String(existing.id).split(':')[0]);
            if (existing.application_id) existing.application_id = Number(String(existing.application_id).split(':')[0]);
            return res.json({ conversation: existing });
        }

        // No existing convo — workers can only START one if accepted
        if (profile.role === "worker" && app.status !== "accepted") {
            return res.status(403).json({ error: "You can only message clinics after being accepted" });
        }

        // Create new conversation
        const { data: conv, error: convErr } = await supabase
            .from("conversations")
            .insert([{
                application_id: appId,
                worker_id:      app.worker_id,
                clinic_id:      app.shifts?.clinic_id,
                worker_name:    app.worker_name,
                clinic_name:    app.shifts?.clinic_name || "Clinic",
                shift_role:     app.shifts?.role || "Shift",
            }])
            .select("*")
            .single();

        if (convErr) return res.status(400).json({ error: convErr.message });
        return res.status(201).json({ conversation: conv });
    } catch (err) {
        console.error("POST /messages/start error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * GET /conversations
 * Returns all conversations for the current user (worker or clinic).
 */
router.get("/conversations", authMiddleware, async (req, res) => {
    try {
        const profile = await getProfile(req.user.id);
        if (!profile) return res.status(403).json({ error: "Profile not found" });

        let query = supabase.from("conversations").select("*");

        if (profile.role === "worker") {
            query = query.eq("worker_id", req.user.id);
        } else if (profile.role === "clinic") {
            query = query.eq("clinic_id", req.user.id);
        } else {
            return res.status(403).json({ error: "Not allowed" });
        }

        const { data: convs, error } = await query.order("updated_at", { ascending: false });
        if (error) return res.status(400).json({ error: error.message });
        return res.json({ conversations: convs || [] });
    } catch (err) {
        console.error("GET /conversations error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * GET /:conversationId
 * Get all messages in a conversation.
 */
router.get("/:conversationId", authMiddleware, async (req, res) => {
    try {
        const profile = await getProfile(req.user.id);
        const convId = Number(req.params.conversationId);

        // Verify user belongs to this conversation
        const { data: conv } = await supabase
            .from("conversations")
            .select("*")
            .eq("id", convId)
            .single();

        if (!conv) return res.status(404).json({ error: "Conversation not found" });
        const isWorker = conv.worker_id === req.user.id;
        const isClinic = conv.clinic_id === req.user.id || (profile.role === 'clinic' && !conv.clinic_id);
        if (!isWorker && !isClinic) {
            return res.status(403).json({ error: "Not allowed" });
        }

        const { data: msgs, error } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", convId)
            .order("created_at", { ascending: true });

        if (error) return res.status(400).json({ error: error.message });
        return res.json({ messages: msgs || [], conversation: conv });
    } catch (err) {
        console.error("GET /messages/:id error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

/**
 * POST /:conversationId
 * Send a message in a conversation.
 */
router.post("/:conversationId", authMiddleware, async (req, res) => {
    try {
        const profile = await getProfile(req.user.id);
        const convId = Number(req.params.conversationId);
        const { text } = req.body;

        if (!text || !text.trim()) return res.status(400).json({ error: "Message text required" });

        // Verify user belongs to this conversation
        const { data: conv } = await supabase
            .from("conversations")
            .select("*")
            .eq("id", convId)
            .single();

        if (!conv) return res.status(404).json({ error: "Conversation not found" });
        const isWorker = conv.worker_id === req.user.id;
        const isClinic = conv.clinic_id === req.user.id || (profile.role === 'clinic' && !conv.clinic_id);
        if (!isWorker && !isClinic) {
            return res.status(403).json({ error: "Not allowed" });
        }

        const senderRole = profile.role; // "worker" or "clinic"

        const { data: msg, error } = await supabase
            .from("messages")
            .insert([{
                conversation_id: convId,
                sender_id:       req.user.id,
                sender_name:     profile.full_name || profile.clinic_name || "User",
                sender_role:     senderRole,
                text:            text.trim(),
            }])
            .select("*")
            .single();

        if (error) return res.status(400).json({ error: error.message });

        // Update conversation updated_at for sorting
        await supabase
            .from("conversations")
            .update({ updated_at: new Date().toISOString(), last_message: text.trim().substring(0, 80) })
            .eq("id", convId);

        return res.status(201).json({ message: msg });
    } catch (err) {
        console.error("POST /messages/:id error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;