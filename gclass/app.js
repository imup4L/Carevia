// Shared behavior for all pages: mobile menu, reveal animations, active nav, modal, shift search, email validation.
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(email).trim());
}

function setFormMessage(form, type, msg){
  const err = form.querySelector(".error");
  const ok = form.querySelector(".success");
  if(err){ err.style.display = "none"; err.textContent = ""; }
  if(ok){ ok.style.display = "none"; ok.textContent = ""; }
  if(type === "error" && err){ err.textContent = msg; err.style.display = "block"; }
  if(type === "success" && ok){ ok.textContent = msg; ok.style.display = "block"; }
}

// --- Mobile menu (per-page) ---
const hamburger = $("#hamburger");
const mobilePanel = $("#mobilePanel");
function setMobileMenu(open){
  if(!hamburger || !mobilePanel) return;
  hamburger.setAttribute("aria-expanded", String(open));
  mobilePanel.hidden = !open;
}
hamburger?.addEventListener("click", () => {
  const open = hamburger.getAttribute("aria-expanded") === "true";
  setMobileMenu(!open);
});
$$("#mobilePanel a").forEach(a => a.addEventListener("click", () => setMobileMenu(false)));
window.addEventListener("resize", () => {
  if(window.matchMedia("(min-width: 821px)").matches) setMobileMenu(false);
});

// --- Reveal animations ---
const revealEls = $$(".reveal");
if(revealEls.length){
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if(e.isIntersecting){
        e.target.classList.add("is-visible");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.14, rootMargin: "0px 0px -6% 0px" });

  revealEls.forEach(el => io.observe(el));
}

// --- Active nav (multi-page: uses body[data-page]) ---
const page = document.body?.dataset?.page;
if(page){
  $$('[data-nav]').forEach(a => a.classList.toggle("active", a.dataset.nav === page));
}

// --- Shift search (only exists on find-shifts page) ---
const shiftSearch = $("#shiftSearch");
const shiftCards = $$("#shiftGrid .shift-card");
function applyShiftFilter(){
  if(!shiftSearch) return;
  const q = (shiftSearch.value || "").trim().toLowerCase();
  let shown = 0;
  shiftCards.forEach(card => {
    const hay = (card.dataset.tags + " " + card.dataset.title + " " + card.dataset.location).toLowerCase();
    const show = !q || hay.includes(q);
    card.style.display = show ? "" : "none";
    if(show) shown++;
  });
  $("#shiftGrid")?.setAttribute("aria-label", shown ? `Showing ${shown} shift cards` : "No shifts match your search");
}
shiftSearch?.addEventListener("input", applyShiftFilter);

const filterBtn = $("#filterBtn");
const presets = ["", "hygienist", "assistant", "front desk", "bellevue", "kirkland", "capitol hill"];
let presetIndex = 0;
filterBtn?.addEventListener("click", () => {
  presetIndex = (presetIndex + 1) % presets.length;
  if(shiftSearch) shiftSearch.value = presets[presetIndex];
  applyShiftFilter();
  filterBtn.blur();
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-apply]");
  if(!btn) return;
  const role = btn.getAttribute("data-apply");
  btn.textContent = "Applied!";
  btn.disabled = true;
  btn.style.opacity = ".9";
  btn.setAttribute("aria-label", `Applied for: ${role}. (Demo)`);
  setTimeout(() => {
    btn.textContent = "Apply Now";
    btn.disabled = false;
    btn.removeAttribute("style");
  }, 2200);
});

// --- Email validation (contact page forms, but safe on all pages) ---
$$(".signup-form").forEach(form => {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const type = form.dataset.form || "form";
    const email = form.querySelector('input[name="email"]')?.value || "";
    if(!email.trim()){
      setFormMessage(form, "error", "Please enter your email address.");
      return;
    }
    if(!isValidEmail(email)){
      setFormMessage(form, "error", "Please enter a valid email (e.g., name@domain.com).");
      return;
    }
    setFormMessage(form, "success",
      type === "clinic"
        ? "Thanks! We’ll contact you with onboarding details."
        : "You’re in! We’ll send Seattle-area shift updates soon."
    );
    form.reset();
  });
});

// --- Modal (Schedule a Demo + reused for login / talk) ---
const demoFab = $("#demoFab");
const modalBackdrop = $("#modalBackdrop");
const modalClose = $("#modalClose");
const demoForm = $("#demoForm");
const demoError = $("#demoError");
const demoSuccess = $("#demoSuccess");

function openModal(title){
  if(!modalBackdrop) return;
  if(title && $("#modalTitle")) $("#modalTitle").textContent = title;
  modalBackdrop.style.display = "block";
  setTimeout(() => {
    modalBackdrop.querySelector('input[name="email"]')?.focus();
  }, 30);
}
function closeModal(){
  if(!modalBackdrop) return;
  modalBackdrop.style.display = "none";
  if(demoError){ demoError.style.display = "none"; demoError.textContent = ""; }
  if(demoSuccess){ demoSuccess.style.display = "none"; demoSuccess.textContent = ""; }
  demoForm?.reset();
  demoFab?.focus();
}

demoFab?.addEventListener("click", () => openModal("Schedule a Demo"));
modalClose?.addEventListener("click", closeModal);
modalBackdrop?.addEventListener("click", (e) => { if(e.target === modalBackdrop) closeModal(); });
window.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && modalBackdrop?.style.display === "block") closeModal();
});

// Extra modal openers via data-action
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if(!el) return;
  const action = el.getAttribute("data-action");
  if(action === "login"){ e.preventDefault(); openModal("Log In / Demo Access"); }
  if(action === "talk-seattle"){ e.preventDefault(); openModal("Talk to the Seattle Team"); }
});

demoForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = demoForm.querySelector('input[name="email"]')?.value || "";
  if(demoError){ demoError.style.display = "none"; demoError.textContent = ""; }
  if(demoSuccess){ demoSuccess.style.display = "none"; demoSuccess.textContent = ""; }

  if(!email.trim()){
    if(demoError){ demoError.textContent = "Please enter your email address."; demoError.style.display = "block"; }
    return;
  }
  if(!isValidEmail(email)){
    if(demoError){ demoError.textContent = "Please enter a valid email (e.g., name@domain.com)."; demoError.style.display = "block"; }
    return;
  }
  if(demoSuccess){ demoSuccess.textContent = "Request received! We’ll reach out to schedule a demo."; demoSuccess.style.display = "block"; }
  demoForm.reset();
});