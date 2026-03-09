async function loadOpenShifts(city = "Seattle") {
  const res = await fetch(`${API_BASE}/api/shifts?city=${encodeURIComponent(city)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load shifts");
  return data.shifts;
}

// Example usage:
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const shifts = await loadOpenShifts("Seattle");
    console.log("Open shifts:", shifts);
    // TODO: render to DOM
  } catch (err) {
    console.error(err);
  }
});