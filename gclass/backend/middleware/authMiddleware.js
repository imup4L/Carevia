/**
 * Extracts Bearer token and verifies it with Supabase.
 * Attaches auth user to req.user.
 */

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing or invalid token" });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: "Missing or invalid token" });
    }

    req.user = data.user;
    req.token = token;
    return next();
  } catch (err) {
    console.error("authMiddleware error:", err);
    return res.status(401).json({ error: "Missing or invalid token" });
  }
};