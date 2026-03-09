/**
 * Main server entry point
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const authRoutes         = require("./routes/auth");
const shiftsRoutes       = require("./routes/shifts");
const applicationsRoutes = require("./routes/applications");
const messagesRoutes     = require("./routes/messages");
const uploadRoutes       = require("./routes/upload");

const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// Only parse JSON for non-multipart requests
app.use((req, res, next) => {
    if (req.headers['content-type']?.includes('multipart/form-data')) return next();
    express.json({ limit: "10mb" })(req, res, next);
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true, service: "carevia-backend" }));

// Routes
app.use("/api/auth",         authRoutes);
app.use("/api/shifts",       shiftsRoutes);
app.use("/api/applications", applicationsRoutes);
app.use("/api/messages",     messagesRoutes);
app.use("/api/upload",       uploadRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    return res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`CareVia backend listening on port ${PORT}`);
});