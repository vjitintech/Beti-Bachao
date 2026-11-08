// Minimal PostgreSQL client (wire protocol v3) — zero dependencies.
// Supports: TLS (sslmode=require / verify-full), SCRAM-SHA-256, MD5 and cleartext auth,
// parameterised queries (extended protocol) with text results. Enough for the
// durable state store; not a general-purpose driver.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export function parseUrl(u) {
  const x = new URL(u);
  // Local → no TLS; private-network host without a dot (e.g. Render internal "dpg-xxx-a") → TLS if offered; public host → TLS required.
  const ssl = x.searchParams.get('sslmode') || (/(localhost|127\.0\.0\.1|^\/)/.test(x.hostname) ? 'disable' : x.hostname.includes('.') ? 'require' : 'prefer');
  return {
    host: decodeURIComponent(x.hostname) || 'localhost', port: Number(x.port) || 5432,
    user: decodeURIComponent(x.username), password: decodeURIComponent(x.password),
    database: decodeURIComponent(x.pathname.slice(1)) || decodeURIComponent(x.username), ssl,
    socketPath: x.searchParams.get('host') || null,
  };
}

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const msg = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]); };

export class PgClient {
  constructor(url) { this.cfg = typeof url === 'string' ? parseUrl(url) : url; this.buf = Buffer.alloc(0); this.waiters = []; this.queue = Promise.resolve(); }

  async connect() {
    const c = this.cfg;
    let sock = c.socketPath ? net.connect(`${c.socketPath}/.s.PGSQL.${c.port}`) : net.connect(c.port, c.host);
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    if (c.ssl !== 'disable' && !c.socketPath) {
      sock.write(Buffer.concat([int32(8), int32(80877103)]));
      const ans = await new Promise((res, rej) => { sock.once('data', (d) => res(d.toString()[0])); sock.once('error', rej); });
      if (ans === 'S') {
        sock = tls.connect({ socket: sock, servername: c.host, rejectUnauthorized: c.ssl === 'verify-full' || c.ssl === 'verify-ca' });
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      } else if (c.ssl === 'require' || c.ssl.startsWith('verify')) throw new Error('PostgreSQL server does not support TLS');
    }
    this.sock = sock;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('PostgreSQL connection closed')));
    const params = Buffer.concat([cstr('user'), cstr(c.user), cstr('database'), cstr(c.database), cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])]);
    sock.write(Buffer.concat([int32(params.length + 8), int32(196608), params]));
    await this.authenticate();
    return this;
  }

  fail(e) { this.dead = e; for (const w of this.waiters.splice(0)) w.rej(e); }

  pump() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const m = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      if (m.type === 'N' || m.type === 'S' || m.type === 'K' || m.type === 'A') continue; // notices, params, key data, notifications
      const w = this.waiters.shift();
      if (w) w.res(m); else (this.pending ||= []).push(m);
    }
  }

  next() {
    if (this.pending?.length) return Promise.resolve(this.pending.shift());
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  }

  static error(body) {
    const f = {};
    for (let i = 0; i < body.length && body[i] !== 0;) { const code = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); f[code] = body.subarray(i + 1, end).toString(); i = end + 1; }
    const e = new Error(`PostgreSQL: ${f.M || 'error'}${f.C ? ` (${f.C})` : ''}`); e.code = f.C; return e;
  }

  async authenticate() {
    const c = this.cfg;
    let scram = null;
    for (;;) {
      const m = await this.next();
      if (m.type === 'E') throw PgClient.error(m.body);
      if (m.type === 'Z') return;
      if (m.type !== 'R') continue;
      const kind = m.body.readInt32BE(0);
      if (kind === 0) continue;
      if (kind === 3) this.sock.write(msg('p', cstr(c.password)));
      else if (kind === 5) {
        const salt = m.body.subarray(4, 8);
        const inner = crypto.createHash('md5').update(c.password + c.user).digest('hex');
        this.sock.write(msg('p', cstr('md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex'))));
      } else if (kind === 10) {
        const mechs = m.body.subarray(4).toString().split('\0');
        if (!mechs.includes('SCRAM-SHA-256')) throw new Error('PostgreSQL: unsupported SASL mechanism');
        const nonce = crypto.randomBytes(18).toString('base64');
        scram = { nonce, first: `n=*,r=${nonce}` };
        const data = Buffer.from('n,,' + scram.first);
        this.sock.write(msg('p', cstr('SCRAM-SHA-256'), int32(data.length), data));
      } else if (kind === 11) {
        const s = Object.fromEntries(m.body.subarray(4).toString().split(',').map((kv) => [kv[0], kv.slice(2)]));
        if (!s.r.startsWith(scram.nonce)) throw new Error('PostgreSQL: SCRAM nonce mismatch');
        const salted = crypto.pbkdf2Sync(c.password, Buffer.from(s.s, 'base64'), Number(s.i), 32, 'sha256');
        const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
        const clientKey = hmac(salted, 'Client Key');
        const storedKey = crypto.createHash('sha256').update(clientKey).digest();
        const without = `c=biws,r=${s.r}`;
        const authMsg = `${scram.first},${m.body.subarray(4).toString()},${without}`;
        const sig = hmac(storedKey, authMsg);
        const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i])).toString('base64');
        scram.serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
        this.sock.write(msg('p', Buffer.from(`${without},p=${proof}`)));
      } else if (kind === 12) {
        const v = m.body.subarray(4).toString();
        if (v !== `v=${scram.serverSig}`) throw new Error('PostgreSQL: server signature mismatch');
      } else throw new Error(`PostgreSQL: unsupported auth method ${kind}`);
    }
  }

  // Parameterised query; params are sent as text (null → SQL NULL). Returns rows as objects of strings.
  query(sql, params = []) {
    const run = async () => {
      const bind = [cstr(''), cstr(''), int16(0), int16(params.length)];
      for (const p of params) {
        if (p === null || p === undefined) bind.push(int32(-1));
        else { const b = Buffer.from(typeof p === 'string' ? p : JSON.stringify(p), 'utf8'); bind.push(int32(b.length), b); }
      }
      bind.push(int16(0));
      this.sock.write(Buffer.concat([msg('P', cstr(''), cstr(sql), int16(0)), msg('B', ...bind), msg('D', Buffer.from('P'), cstr('')), msg('E', cstr(''), int32(0)), msg('S')]));
      let cols = []; const rows = []; let error = null;
      for (;;) {
        const m = await this.next();
        if (m.type === 'E') error = PgClient.error(m.body);
        else if (m.type === 'T') {
          const n = m.body.readInt16BE(0); let o = 2; cols = [];
          for (let i = 0; i < n; i++) { const end = m.body.indexOf(0, o); cols.push(m.body.subarray(o, end).toString()); o = end + 1 + 18; }
        } else if (m.type === 'D') {
          const n = m.body.readInt16BE(0); let o = 2; const row = {};
          for (let i = 0; i < n; i++) { const l = m.body.readInt32BE(o); o += 4; row[cols[i]] = l < 0 ? null : m.body.subarray(o, o + l).toString('utf8'); if (l > 0) o += l; }
          rows.push(row);
        } else if (m.type === 'Z') { if (error) throw error; return rows; }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  end() { try { this.sock?.write(msg('X')); this.sock?.end(); } catch {} }
}
