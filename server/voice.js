// Automatic phone call that connects the nearest police station with her phone.
// The station is called first; when they pick up, her phone is dialled and both are
// connected. The SMS with her live location goes out at the same time (sms.js).
//   VOICE_PROVIDER=exotel  EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_CALLER_ID
//                          (an ExoPhone), EXOTEL_SUBDOMAIN (api.exotel.com or api.in.exotel.com)
//   VOICE_PROVIDER=twilio  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VOICE_FROM (or TWILIO_FROM)
//   VOICE_PROVIDER=log     prints the call to the server log (testing only)
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const e164 = (p) => (String(p).startsWith('+') ? String(p) : `+${String(p).replace(/\D/g, '')}`);

export function createVoice(env, { fetchImpl = fetch, log = console.log } = {}) {
  const provider = (env.VOICE_PROVIDER || '').toLowerCase();
  const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  if (provider === 'exotel') {
    for (const k of ['EXOTEL_SID', 'EXOTEL_API_KEY', 'EXOTEL_API_TOKEN', 'EXOTEL_CALLER_ID']) if (!env[k]) throw new Error(`${k} is required`);
    const host = env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
    return {
      name: 'exotel',
      async bridge({ first, second }) {
        const body = new URLSearchParams({ From: first, To: second, CallerId: env.EXOTEL_CALLER_ID, TimeLimit: '1800', TimeOut: '40' });
        try {
          const res = await fetchImpl(`https://${host}/v1/Accounts/${env.EXOTEL_SID}/Calls/connect.json`, {
            method: 'POST', signal: timeout(15000),
            headers: { Authorization: 'Basic ' + Buffer.from(`${env.EXOTEL_API_KEY}:${env.EXOTEL_API_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status };
        } catch (e) { return { ok: false, error: e.message }; }
      },
    };
  }
  if (provider === 'twilio') {
    const from = env.TWILIO_VOICE_FROM || env.TWILIO_FROM;
    for (const [k, v] of [['TWILIO_ACCOUNT_SID', env.TWILIO_ACCOUNT_SID], ['TWILIO_AUTH_TOKEN', env.TWILIO_AUTH_TOKEN], ['TWILIO_VOICE_FROM', from]]) if (!v) throw new Error(`${k} is required`);
    return {
      name: 'twilio',
      async bridge({ first, second, message }) {
        const twiml = `<Response><Say language="en-IN">${xml(message)}</Say><Say language="en-IN">Connecting you to her now.</Say><Dial callerId="${xml(from)}" timeout="40">${xml(e164(second))}</Dial></Response>`;
        const body = new URLSearchParams({ To: e164(first), From: from, Twiml: twiml });
        try {
          const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
            method: 'POST', signal: timeout(15000),
            headers: { Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          return { ok: res.status >= 200 && res.status < 300, status: res.status };
        } catch (e) { return { ok: false, error: e.message }; }
      },
    };
  }
  if (provider === 'log') return { name: 'log', calls: [], async bridge(c) { this.calls.push(c); log(`[voice:log] call ${c.first} then connect ${c.second}: ${c.message}`); return { ok: true }; } };
  return null;
}
