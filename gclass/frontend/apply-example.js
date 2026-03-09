async function applyToShift(shiftId) {
  const token = localStorage.getItem("carevia_token");
  if (!token) throw new Error("Not logged in");

  const res = await fetch(`${API_BASE}/api/applications/${shiftId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    }
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to apply");

  return data.application;
}