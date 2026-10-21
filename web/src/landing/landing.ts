// Malachi – Startseite: nur Darstellungslogik, keinerlei Netzwerkzugriffe.
// (Laeuft als eigenes Modul, weil die CSP des Relays Inline-Skripte verbietet.)

// 1) Einblenden beim Scrollen - ohne IntersectionObserver einfach sofort zeigen.
const reveals = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('in'));
}

// 2) Mobiles Menue
const menuBtn = document.querySelector<HTMLButtonElement>('.menu-btn');
const links = document.getElementById('nav-links');
if (menuBtn && links) {
  menuBtn.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  links.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName === 'A') {
      links.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });
}

// 3) Wer die Web-App schon eingerichtet hat, sieht "Weiter zu deinen Chats".
//    Liest nur, OB ein PIN-Salt existiert (siehe lib/Storage.ts hasPinSetup) -
//    keine Inhalte, nichts verlaesst das Geraet.
try {
  const hasSetup = window.localStorage.getItem('malachi___pin_salt') !== null; // = Storage.ts SALT_KEY
  if (hasSetup) {
    document.querySelectorAll<HTMLAnchorElement>('[data-app-cta]').forEach((a) => {
      a.textContent = 'Weiter zu deinen Chats';
    });
  }
} catch {
  /* localStorage gesperrt (privater Modus) - Standardtext bleibt */
}
