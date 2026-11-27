// Contact page (website only): builds an email to the team and opens the visitor's mail app.
// No data is sent to or stored on our server.
(() => {
  const TO = 'betibachao24x7@gmail.com';
  const TOPICS = { general: 'General question', volunteer: 'Becoming a volunteer', csr: 'CSR partnership', investor: 'Investor enquiry', media: 'Media enquiry', support: 'Help with the app' };
  const form = document.getElementById('contact-form');
  if (!form) return;
  const err = document.getElementById('contact-error');
  const pre = new URLSearchParams(location.search).get('topic');
  if (pre && TOPICS[pre]) form.topic.value = pre;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (k) => String(form[k].value || '').trim();
    const missing = !v('name') ? 'your name' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email')) ? 'a valid email address' : !v('message') ? 'a message' : '';
    if (missing) { err.textContent = `Please enter ${missing}.`; err.hidden = false; return; }
    err.hidden = true;
    const subject = `${TOPICS[v('topic')] || 'Enquiry'} from ${v('name')}`;
    const body = `${v('message')}\n\n—\nName: ${v('name')}\nEmail: ${v('email')}${v('phone') ? `\nPhone: ${v('phone')}` : ''}\nSent from betibachao24x7.com/contact`;
    location.href = `mailto:${TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
})();
