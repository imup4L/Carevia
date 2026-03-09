async function postShift(payload) {
  const token = localStorage.getItem("carevia_token");
  if (!token) throw new Error("Not logged in");

  const res = await fetch(`${API_BASE}/api/shifts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to post shift");

  return data.shift;
}

// Example payload:
const newShift = {
  role: "Dental Assistant",
  city: "Seattle",
  address: "123 Pine St, Seattle, WA",
  date: "2026-03-20",
  start_time: "09:00",
  end_time: "17:00",
  pay_per_hour: 35.00,
  description: "Busy general dentistry practice, friendly team.",
  requirements: "X-ray certified preferred."
};