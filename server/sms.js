// SMS gateway adapters. Used when the phone itself cannot send SMS (iPhone users,
// alert fallback to volunteers, password-reset codes).
//   SMS_PROVIDER=msg91   MSG91_AUTH_KEY, MSG91_TEMPLATE_SOS, _ALERT, _OTP, _VERIFY, _POLICE, _TRIP_START, _TRIP_SAFE, _WAITING
//                        (India: each template must be registered on DLT and approved in MSG91)
//   SMS_PROVIDER=twilio  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   SMS_PROVIDER=log     prints messages to the server log (testing only)

export const TEXT = {
  SOS: (v) => `SOS! ${v.name} is in danger and needs help. Live location: ${v.link} - Beti Bachao. Call her or 112.`,
  WAITING: (v) => `Beti Bachao: ${v.name} is STILL WAITING for help - no responder yet. Live location: ${v.link} Please call her or 112 now.`,
  ALERT: (v) => `Beti Bachao: SOS ${v.distance} km from you. Open the app now to respond.`,
  OTP: (v) => `Your Beti Bachao code is ${v.otp}. It expires in 10 minutes. Do not share it.`,
  POLICE: (v) => `SOS - Beti Bachao: ${v.name} (${v.phone}) needs police help near your station. Live location: ${v.link} Ref ${v.ref}`,
  TRIP_START: (v) => `${v.name} is travelling to ${v.dest} (vehicle ${v.vehicle}). Follow her live: ${v.link} - Beti Bachao`,
  TRIP_SAFE: (v) => `${v.name} reached ${v.dest} safely. - Beti Bachao`,
  VERIFY: (v) => `Beti Bachao: your volunteer verification video call is at ${v.time}. Join from the app. Keep your Aadhaar card ready.`,
};

export function createSms(env, { fetchImpl = fetch, log = console.log } = {}) {
  const provider = (env.SMS_PROVIDER || '').toLowerCase();
  const timeout = (ms) => AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  if (provider === 'msg91') {
    if (!env.MSG91_AUTH_KEY) throw new Error('MSG91_AUTH_KEY is required');
    return {
      name: 'msg91',
      async send(to, template, vars) {
        // WAITING reuses the SOS template until its own DLT template is approved.
        const templateId = env[`MSG91_TEMPLATE_${template}`] || (template === 'WAITING' ? env.MSG91_TEMPLATE_SOS : null);
        if (!templateId) return { ok: false, error: `MSG91_TEMPLATE_${template} not set` };
        const mobiles = String(to).replace(/\D/g, '').replace(/^(?!91)(\d{10})$/, '91$1');
        try {
          const res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
            method: 'POST', signal: timeout(10000),
            headers: { authkey: env.MSG91_AUTH_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [{ mobiles, ...vars }] }),
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status };
        } catch (e) { return { ok: false, error: e.message }; }
      },
    };
  }
  if (provider === 'twilio') {
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']) if (!env[k]) throw new Error(`${k} is required`);
    return {
      name: 'twilio',
      async send(to, template, vars) {
        const body = new URLSearchParams({ To: String(to).startsWith('+') ? to : `+${String(to).replace(/\D/g, '')}`, From: env.TWILIO_FROM, Body: TEXT[template](vars) });
        try {
          const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
            method: 'POST', signal: timeout(10000),
            headers: { Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status };
        } catch (e) { return { ok: false, error: e.message }; }
      },
    };
  }
  if (provider === 'log') return { name: 'log', sent: [], async send(to, template, vars) { this.sent.push({ to, template, vars }); log(`[sms:log] to ${to}: ${TEXT[template](vars)}`); return { ok: true }; } };
  return null;
}
